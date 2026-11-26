/**
 * Web-standard (`Request` -> `Response`) A2A v1.0 server transport.
 *
 * Runs on any fetch-style runtime; designed for `Bun.serve` routes:
 *
 * ```ts
 * const a2a = a2aFetchHandlers({ requestHandler });
 * Bun.serve({ routes: { '/.well-known/agent-card.json': a2a.agentCard, '/a2a': { POST: a2a.jsonRpc } } });
 * ```
 *
 * Only the v1.0 JSON-RPC binding is served; use the express transport for the v0.3 compat layer.
 */
import { JSONRPCErrorResponse } from '../../core.js';
import { A2A_VERSION_HEADER, HTTP_EXTENSION_HEADER, JSON_CONTENT_TYPE } from '../../constants.js';
import { A2A_ERROR_CODE, ContentTypeNotSupportedError } from '../../errors/index.js';
import { Extensions } from '../../extensions.js';
import { SSE_HEADERS, formatSSEErrorEvent, formatSSEEvent } from '../../sse_utils.js';
import { User, UnauthenticatedUser } from '../authentication/user.js';
import {
  RequestHeaders,
  ServerCallContextBuilder,
  defaultServerCallContextBuilder,
} from '../context.js';
import { A2ARequestHandler } from '../request_handler/a2a_request_handler.js';
import {
  JSONRPCResponse,
  JsonRpcTransportHandler,
} from '../transports/jsonrpc/jsonrpc_transport_handler.js';
import { validateVersion } from '../version.js';

export type FetchUserBuilder = (req: Request) => Promise<User>;

export interface FetchHandlerOptions {
  requestHandler: A2ARequestHandler;
  /** Defaults to no authentication. */
  userBuilder?: FetchUserBuilder;
  contextBuilder?: ServerCallContextBuilder;
  /** Agent card `Cache-Control: max-age`, seconds. Defaults to 3600. */
  cardMaxAge?: number;
}

export interface FetchHandlers {
  /** `GET` handler for `/.well-known/agent-card.json`. */
  agentCard: (req: Request) => Promise<Response>;
  /** `POST` handler for the JSON-RPC endpoint. */
  jsonRpc: (req: Request) => Promise<Response>;
}

function toRequestHeaders(headers: Headers): RequestHeaders {
  const out: RequestHeaders = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': JSON_CONTENT_TYPE, ...headers },
  });
}

async function etagOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return `W/"${hex}"`;
}

/** RFC 9110 If-None-Match: `*` or a comma-separated list of (weak or strong) ETags, compared weakly. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

/** How long jsonRpc reuses the agent card it validates the protocol version against, ms. */
const CARD_TTL_MS = 5000;

export function a2aFetchHandlers(options: FetchHandlerOptions): FetchHandlers {
  const transport = new JsonRpcTransportHandler(options.requestHandler);
  const userBuilder: FetchUserBuilder =
    options.userBuilder ?? (() => Promise.resolve(new UnauthenticatedUser()));
  const maxAge = options.cardMaxAge ?? 3600;

  const agentCard = async (req: Request): Promise<Response> => {
    try {
      const body = JSON.stringify(await options.requestHandler.getAgentCard());
      const etag = await etagOf(body);
      const headers = { 'Cache-Control': `public, max-age=${maxAge}`, ETag: etag };
      if (etagMatches(req.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(body, {
        headers: { 'Content-Type': JSON_CONTENT_TYPE, ...headers },
      });
    } catch (error) {
      console.error('Error fetching agent card:', error);
      return json({ error: 'Failed to retrieve agent card' }, 500);
    }
  };

  let cardCache:
    | { at: number; card: Promise<Awaited<ReturnType<A2ARequestHandler['getAgentCard']>>> }
    | undefined;
  const cachedCard = () => {
    if (!cardCache || Date.now() - cardCache.at > CARD_TTL_MS) {
      const card = options.requestHandler.getAgentCard();
      card.catch(() => (cardCache = undefined));
      cardCache = { at: Date.now(), card };
    }
    return cardCache.card;
  };

  const jsonRpc = async (req: Request): Promise<Response> => {
    let body: (Record<string, unknown> & { id?: string | number | null }) | undefined;
    const errorResponse = (error: unknown): JSONRPCErrorResponse => ({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: JsonRpcTransportHandler.mapToJSONRPCError(error),
    });

    const contentType = req.headers.get('content-type');
    if (contentType) {
      const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== JSON_CONTENT_TYPE) {
        return json(
          errorResponse(new ContentTypeNotSupportedError(`Unsupported media type: ${mediaType}`))
        );
      }
    }

    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({
        jsonrpc: '2.0',
        id: null,
        error: { code: A2A_ERROR_CODE.PARSE_ERROR, message: 'Invalid JSON payload.' },
      });
    }

    // Batches (arrays) and non-object bodies are not A2A requests; reject them before any other work.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      body = undefined;
      return json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: A2A_ERROR_CODE.INVALID_REQUEST,
          message: 'Request must be a single JSON-RPC object; batches are not supported.',
        },
      });
    }

    try {
      const user = await userBuilder(req);
      const context = (options.contextBuilder ?? defaultServerCallContextBuilder)({
        extensions: Extensions.parseServiceParameter(
          req.headers.get(HTTP_EXTENSION_HEADER) ?? undefined
        ),
        user,
        headers: toRequestHeaders(req.headers),
        requestedVersion: req.headers.get(A2A_VERSION_HEADER) || undefined,
        protocolBinding: 'JSONRPC',
      });
      context.setProtocolBindingIfAbsent('JSONRPC');
      validateVersion(context.requestedVersion, await cachedCard(), 'JSONRPC');
      const result = await transport.handle(body, context);
      const extHeaders = (): Record<string, string> =>
        context.activatedExtensions
          ? { [HTTP_EXTENSION_HEADER]: Array.from(context.activatedExtensions).join(', ') }
          : {};

      if (typeof (result as AsyncGenerator)?.[Symbol.asyncIterator] !== 'function') {
        return json(result as JSONRPCResponse, 200, extHeaders());
      }

      // Peek the first event so early failures answer as a plain JSON-RPC error.
      const iterator = (result as AsyncGenerator<JSONRPCResponse, void, undefined>)[
        Symbol.asyncIterator
      ]();
      let first: IteratorResult<JSONRPCResponse>;
      try {
        first = await iterator.next();
      } catch (error) {
        return json(errorResponse(error), 200, extHeaders());
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!first.done) controller.enqueue(encoder.encode(formatSSEEvent(first.value)));
          else controller.close();
        },
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(formatSSEEvent(next.value)));
          } catch (error) {
            controller.enqueue(encoder.encode(formatSSEErrorEvent(errorResponse(error))));
            controller.close();
          }
        },
        async cancel() {
          await iterator.return?.();
        },
      });
      return new Response(stream, { headers: { ...SSE_HEADERS, ...extHeaders() } });
    } catch (error) {
      const err = errorResponse(error);
      return json(err, err.error.code === A2A_ERROR_CODE.INTERNAL_ERROR ? 500 : 200);
    }
  };

  return { agentCard, jsonRpc };
}

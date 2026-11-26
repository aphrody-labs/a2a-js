// Runs under `bun test` only: exercises the fetch transport on a real Bun.serve.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { a2aFetchHandlers } from '../../src/server/fetch/index.js';
import { JsonRpcTransportHandler } from '../../src/server/transports/jsonrpc/jsonrpc_transport_handler.js';
import type { A2ARequestHandler } from '../../src/server/request_handler/a2a_request_handler.js';
import type { AgentCard } from '../../src/index.js';
import { A2A_ERROR_CODE } from '../../src/errors/index.js';

const card = {
  name: 'Bun Agent',
  description: 'test',
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
  securityRequirements: [],
  securitySchemes: {},
  signatures: [],
  supportedInterfaces: [
    { url: 'http://localhost/a2a', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
  ],
} as unknown as AgentCard;

const requestHandler = { getAgentCard: async () => card } as unknown as A2ARequestHandler;
const a2a = a2aFetchHandlers({ requestHandler });
let server: ReturnType<typeof Bun.serve>;

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(new URL('/a2a', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    routes: {
      '/.well-known/agent-card.json': { GET: a2a.agentCard },
      '/a2a': { POST: a2a.jsonRpc },
    },
  });
});
afterAll(() => server.stop(true));
afterEach(() => {
  (JsonRpcTransportHandler.prototype.handle as { mockRestore?: () => void }).mockRestore?.();
});

describe('a2aFetchHandlers on Bun.serve', () => {
  it('serves the agent card with ETag and 304', async () => {
    const res = await fetch(new URL('/.well-known/agent-card.json', server.url));
    expect(res.status).toBe(200);
    expect(((await res.json()) as AgentCard).name).toBe('Bun Agent');
    const etag = res.headers.get('etag')!;
    const again = await fetch(new URL('/.well-known/agent-card.json', server.url), {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('answers a unary call as JSON', async () => {
    spyOn(JsonRpcTransportHandler.prototype, 'handle').mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    } as never);
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: {} });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('streams SSE events', async () => {
    spyOn(JsonRpcTransportHandler.prototype, 'handle').mockResolvedValue(
      (async function* () {
        yield { jsonrpc: '2.0', id: 2, result: { n: 1 } };
        yield { jsonrpc: '2.0', id: 2, result: { n: 2 } };
      })() as never
    );
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'SendStreamingMessage', params: {} });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text.match(/^data: /gm)?.length).toBe(2);
  });

  it('rejects bad JSON, wrong content type and unsupported versions', async () => {
    const parse = (await (await rpc('{')).json()) as { error: { code: number } };
    expect(parse.error.code).toBe(A2A_ERROR_CODE.PARSE_ERROR);
    const ct = (await (await rpc({}, { 'content-type': 'text/plain' })).json()) as {
      error: { code: number };
    };
    expect(ct.error.code).toBe(A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED);
    const ver = await rpc({ jsonrpc: '2.0', id: 3, method: 'GetTask' }, { 'a2a-version': '9.9' });
    expect(((await ver.json()) as { id: number }).id).toBe(3);
  });
});

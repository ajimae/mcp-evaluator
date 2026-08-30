import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MCPEvalClient, parseConfig } from '../dist/index.mjs';
import { startMockMcpServer } from './helpers/mock-mcp-server.mjs';

const TOOLS = [
  { name: 'search', description: 'search things', inputSchema: { type: 'object' } },
  { name: 'get_document', description: 'fetch a document', inputSchema: { type: 'object' } },
];

/** Builds a validated server config so tests exercise the same defaults the CLI applies. */
function serverConfig(url, overrides = {}) {
  return parseConfig({ server: { url, ...overrides } }).server;
}

describe('MCPEvalClient', () => {
  const servers = [];
  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it('completes the handshake and lists tools over a JSON transport', async () => {
    const server = await startMockMcpServer({ tools: TOOLS });
    servers.push(server);

    const client = new MCPEvalClient(serverConfig(server.url));
    await client.connect();
    const tools = await client.listTools();

    assert.equal(server.received.initialized, true, 'sends notifications/initialized');
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['search', 'get_document']
    );
    await client.disconnect();
  });

  it('parses responses delivered as an SSE stream', async () => {
    const server = await startMockMcpServer({ tools: TOOLS, mode: 'sse' });
    servers.push(server);

    const client = new MCPEvalClient(serverConfig(server.url));
    await client.connect();

    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ['search', 'get_document']
    );
    await client.disconnect();
  });

  it('narrows the advertised tools to the scenario allowlist', async () => {
    const server = await startMockMcpServer({ tools: TOOLS });
    servers.push(server);

    const client = new MCPEvalClient(serverConfig(server.url));
    await client.connect(['search']);

    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ['search']
    );
    await client.disconnect();
  });

  it('sends configured headers and reuses the session id', async () => {
    const server = await startMockMcpServer({ tools: TOOLS, requireAuth: true });
    servers.push(server);

    const client = new MCPEvalClient(
      serverConfig(server.url, { headers: { authorization: 'Bearer secret' } })
    );
    await client.connect();
    await client.listTools();

    const [initHeaders, , listHeaders] = server.received.headers;
    assert.equal(initHeaders.authorization, 'Bearer secret');
    assert.equal(initHeaders['mcp-session-id'], undefined, 'no session id before initialize');
    assert.equal(listHeaders['mcp-session-id'], 'session-abc');
    assert.equal(listHeaders['mcp-protocol-version'], '2025-06-18');
    await client.disconnect();
  });

  it('only sends _meta when the server config asks for it', async () => {
    const plain = await startMockMcpServer({ tools: TOOLS });
    servers.push(plain);
    const plainClient = new MCPEvalClient(serverConfig(plain.url));
    await plainClient.connect(['search']);
    await plainClient.listTools();
    assert.deepEqual(plain.received.meta, [], 'plain MCP servers get no _meta');

    const gateway = await startMockMcpServer({ tools: TOOLS });
    servers.push(gateway);
    const gatewayClient = new MCPEvalClient(
      serverConfig(gateway.url, { sendEnabledToolsMeta: true, requestMeta: { tenant: 't1' } })
    );
    await gatewayClient.connect(['search']);
    await gatewayClient.listTools();
    assert.deepEqual(gateway.received.meta[0], { tenant: 't1', tools: ['search'] });
  });

  it('returns tool errors as isError results instead of throwing', async () => {
    const server = await startMockMcpServer({ tools: TOOLS });
    servers.push(server);

    const client = new MCPEvalClient(serverConfig(server.url));
    await client.connect();
    const result = await client.callTool('nope', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  });

  it('reports an unreachable server as a readable error', async () => {
    const client = new MCPEvalClient(serverConfig('http://127.0.0.1:1/mcp'));
    await assert.rejects(() => client.connect(), /Request to http:\/\/127\.0\.0\.1:1\/mcp failed/);
  });
});

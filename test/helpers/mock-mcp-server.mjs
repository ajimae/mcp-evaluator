import { createServer } from 'node:http';

/**
 * A minimal in-process MCP server over Streamable HTTP, used to exercise the client without a real
 * server. `mode: 'sse'` returns responses as a text/event-stream so both reply encodings are covered.
 */
export async function startMockMcpServer({ tools = [], mode = 'json', requireAuth = false } = {}) {
  const received = { initialized: false, headers: [], toolCalls: [], meta: [] };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.headers.push(req.headers);

      if (requireAuth && req.headers.authorization !== 'Bearer secret') {
        res.writeHead(401).end('unauthorized');
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(204).end();
        return;
      }

      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (message.params?._meta) received.meta.push(message.params._meta);

      if (message.method === 'notifications/initialized') {
        received.initialized = true;
        res.writeHead(202).end();
        return;
      }

      const result = handle(message, tools, received);
      reply(res, { jsonrpc: '2.0', id: message.id, ...result }, mode, message.method);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    /** Clears everything recorded so far, so assertions describe one test's traffic. */
    reset() {
      received.initialized = false;
      received.headers.length = 0;
      received.toolCalls.length = 0;
      received.meta.length = 0;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function handle(message, tools, received) {
  switch (message.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return { result: { tools } };
    case 'tools/call': {
      received.toolCalls.push({ name: message.params.name, args: message.params.arguments });
      const tool = tools.find((candidate) => candidate.name === message.params.name);
      if (!tool) return { error: { code: -32602, message: `Unknown tool: ${message.params.name}` } };
      return { result: { content: [{ type: 'text', text: tool.reply ?? 'ok' }], isError: false } };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

function reply(res, body, mode, method) {
  const headers = { 'content-type': 'application/json' };
  if (method === 'initialize') headers['mcp-session-id'] = 'session-abc';

  if (mode === 'sse') {
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    // Include a keep-alive comment and an unrelated event to prove the parser is not naive.
    res.end(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`);
    return;
  }

  res.writeHead(200, headers).end(JSON.stringify(body));
}

import { createServer } from 'node:http';

/**
 * A mock Ollama `/api/chat` endpoint. Each entry in `turns` is the message the "model" returns for
 * the corresponding request, letting a test script an exact tool-calling trajectory.
 */
export async function startMockOllama(initialTurns = []) {
  let turns = initialTurns;
  let index = 0;
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;

      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          message: { content: turn.content ?? '', tool_calls: turn.toolCalls ?? [] },
          prompt_eval_count: 10,
          eval_count: 5,
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** Re-scripts the model, so each test starts from a known trajectory. */
    reset(nextTurns) {
      turns = nextTurns;
      index = 0;
      requests.length = 0;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Shorthand for a mock turn that calls one tool. */
export function toolCall(name, args = {}) {
  return { toolCalls: [{ function: { name, arguments: args } }] };
}

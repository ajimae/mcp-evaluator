// Using mcp-evaluator as a library — run it from your own script, CI job or test suite.
// Run with: node examples/programmatic.mjs
import { runEvals } from 'mcp-evaluator';

const { results, passRate, passed, total } = await runEvals({
  server: { url: process.env.MCP_URL ?? 'http://localhost:3000/mcp' },
  models: ['anthropic:claude-sonnet-5', 'ollama:llama3.1:8b'],
  scenarios: [
    {
      id: 'search.keyword',
      messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
      expectedToolCalls: [{ toolName: 'search' }],
    },
  ],
  // Suppress the built-in tables and do your own thing with the results.
  reporters: { console: false },
});

console.log(`${passed}/${total} passed (${(passRate * 100).toFixed(0)}%)`);

for (const result of results) {
  const tools = result.run.toolCalls.map((call) => call.toolName).join(' → ') || '(no tools called)';
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.scenario.id}  ${tools}`);
}

// Fail the surrounding process/CI job on a regression.
if (passRate < 0.8) process.exitCode = 1;

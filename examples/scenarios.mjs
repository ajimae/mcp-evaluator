// A standalone scenario suite, loaded with `mcp-evaluator --scenarios examples/scenarios.mjs`.
// Useful for keeping several suites (smoke, full, regression) next to one config.

/** @type {import('mcp-evaluator').EvalScenario[]} */
export default [
  {
    id: 'smoke.search',
    messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
    expectedToolCalls: [{ toolName: 'search' }],
    tags: ['smoke'],
  },
  {
    id: 'smoke.read',
    messages: [{ role: 'user', content: 'Fetch document doc-123.' }],
    expectedToolCalls: [{ toolName: 'get_document', requiredParams: { id: 'doc-123' } }],
    tags: ['smoke'],
  },
];

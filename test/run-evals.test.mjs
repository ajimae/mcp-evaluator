import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEvals } from '../dist/index.mjs';
import { startMockMcpServer } from './helpers/mock-mcp-server.mjs';
import { startMockOllama, toolCall } from './helpers/mock-ollama.mjs';

/**
 * End-to-end coverage: a mock MCP server plus a scripted mock model, driven through the real
 * orchestrator. The `ollama` provider is used because it speaks plain HTTP, so no vendor SDK or
 * API key is involved.
 */

const TOOLS = [
  { name: 'search', description: 'search things', inputSchema: { type: 'object' } },
  { name: 'get_document', description: 'fetch a document', inputSchema: { type: 'object' } },
];

const SCENARIOS = [
  {
    id: 'search.basic',
    messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
    expectedToolCalls: [{ toolName: 'search' }],
    tags: ['search'],
  },
  {
    id: 'read.by-id',
    messages: [{ role: 'user', content: 'Fetch document doc-123.' }],
    expectedToolCalls: [{ toolName: 'get_document', requiredParams: { id: 'doc-123' } }],
    tags: ['read'],
  },
];

describe('runEvals', () => {
  let mcp;
  let ollama;
  let previousBaseUrl;

  before(async () => {
    mcp = await startMockMcpServer({ tools: TOOLS });
    ollama = await startMockOllama();
    previousBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = ollama.baseUrl;
  });

  // Each scenario takes two turns: call the right tool, then answer in prose and end the loop.
  const SCRIPT = [
    toolCall('search', {}),
    { content: 'Found 3 matching products.' },
    toolCall('get_document', { id: 'doc-123' }),
    { content: 'Here is the document.' },
  ];

  beforeEach(() => {
    mcp.reset();
    ollama.reset(SCRIPT);
  });

  after(async () => {
    if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousBaseUrl;
    await Promise.all([mcp.close(), ollama.close()]);
  });

  it('runs every scenario against every model and grades the result', async () => {
    const summary = await runEvals({
      server: { url: mcp.url },
      models: ['ollama:test-model'],
      scenarios: SCENARIOS,
      reporters: { console: false },
    });

    assert.equal(summary.total, 2);
    assert.equal(summary.passed, 2);
    assert.equal(summary.passRate, 1);
    assert.deepEqual(
      mcp.received.toolCalls,
      [
        { name: 'search', args: {} },
        { name: 'get_document', args: { id: 'doc-123' } },
      ],
      'tool calls reach the MCP server with the model-supplied arguments'
    );
    assert.equal(summary.results[0].run.finalText, 'Found 3 matching products.');
    assert.ok(summary.results[0].run.inputTokens > 0, 'token usage is captured');
  });

  it('writes the markdown and json reports when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-evaluator-'));
    const markdownPath = join(dir, 'summary.md');
    const jsonPath = join(dir, 'results.json');

    await runEvals({
      server: { url: mcp.url },
      models: ['ollama:test-model'],
      scenarios: [SCENARIOS[0]],
      reporters: { console: false, markdown: markdownPath, json: jsonPath },
    });

    const markdown = readFileSync(markdownPath, 'utf8');
    assert.match(markdown, /\*\*Leaderboard\*\*/);
    assert.match(markdown, /ollama:test-model/);

    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(report.summary.scenarios, 1);
    assert.equal(report.results[0].scenario, 'search.basic');
    assert.equal(report.results[0].scores.correct_tool_selected, 1);
  });

  it('records an unreachable server as a failed run instead of throwing', async () => {
    const summary = await runEvals({
      server: { url: 'http://127.0.0.1:1/mcp' },
      models: ['ollama:test-model'],
      scenarios: [SCENARIOS[0]],
      reporters: { console: false },
    });

    assert.equal(summary.passed, 0);
    assert.match(summary.results[0].run.error, /failed/);
  });

  it('rejects a run with no models or no scenarios', async () => {
    await assert.rejects(
      () => runEvals({ server: { url: mcp.url }, scenarios: SCENARIOS, reporters: { console: false } }),
      /No models to evaluate/
    );
    await assert.rejects(
      () => runEvals({ server: { url: mcp.url }, models: ['ollama:m'], reporters: { console: false } }),
      /No scenarios to run/
    );
  });
});

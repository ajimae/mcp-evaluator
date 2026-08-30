import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runEvals } from '../dist/index.mjs';
import { startMockMcpServer } from './helpers/mock-mcp-server.mjs';
import { startMockOllama, toolCall } from './helpers/mock-ollama.mjs';

/**
 * LLM-as-a-judge coverage. The judge is just another provider call, so a scripted mock model can
 * stand in for it — including the malformed replies a real judge sometimes returns.
 */

const TOOLS = [{ name: 'search', description: 'search things', inputSchema: { type: 'object' } }];

const SCENARIO = {
  id: 'search.basic',
  messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
  expectedToolCalls: [{ toolName: 'search' }],
};

/** The two model turns every scenario needs, before the judge's turn. */
const SOLVE = [toolCall('search', {}), { content: 'Found 3 results.' }];

const scoreOf = (result, name) => result.scores.find((score) => score.name === name)?.value;

describe('llm-as-a-judge', () => {
  let mcp;
  let ollama;
  let previousBaseUrl;

  before(async () => {
    mcp = await startMockMcpServer({ tools: TOOLS });
    ollama = await startMockOllama();
    previousBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = ollama.baseUrl;
  });

  beforeEach(() => {
    mcp.reset();
  });

  after(async () => {
    if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousBaseUrl;
    await Promise.all([mcp.close(), ollama.close()]);
  });

  /** Runs one scenario with the judge on, scripting the judge's reply as the final turn. */
  async function runWithJudge(judgeReply, overrides = {}) {
    ollama.reset([...SOLVE, { content: judgeReply }]);
    const summary = await runEvals({
      server: { url: mcp.url },
      models: ['ollama:test-model'],
      scenarios: [SCENARIO],
      judge: { enabled: true },
      reporters: { console: false },
      ...overrides,
    });
    return summary.results[0];
  }

  it('adds judge scores alongside the deterministic ones', async () => {
    const result = await runWithJudge(
      '{"tool_appropriateness": 1, "answer_satisfies_intent": 0.8, "reasoning": "picked the search tool"}'
    );

    assert.equal(scoreOf(result, 'tool_appropriateness'), 1);
    assert.equal(scoreOf(result, 'answer_satisfies_intent'), 0.8);
    assert.equal(scoreOf(result, 'correct_tool_selected'), 1, 'deterministic scores still present');
    assert.equal(
      result.scores.find((score) => score.name === 'tool_appropriateness').comment,
      'picked the search tool'
    );
  });

  it('never sends an empty tools array on the judge turn', async () => {
    await runWithJudge('{"tool_appropriateness": 1, "answer_satisfies_intent": 1}');

    const judgeRequest = ollama.requests.at(-1);
    assert.equal(
      'tools' in judgeRequest,
      false,
      'the key is omitted, not sent as [] — some provider APIs reject an empty array'
    );
    assert.ok('tools' in ollama.requests[0], 'the solving turns still advertise tools');
  });

  it('tolerates prose around the judge JSON', async () => {
    const result = await runWithJudge(
      'Sure! Here is my assessment:\n```json\n{"tool_appropriateness": 0.5, "answer_satisfies_intent": 0.5}\n```'
    );

    assert.equal(scoreOf(result, 'tool_appropriateness'), 0.5);
  });

  it('drops unparseable judge output without failing the run', async () => {
    const result = await runWithJudge('I cannot evaluate this.');

    assert.equal(scoreOf(result, 'tool_appropriateness'), undefined);
    assert.equal(result.passed, true, 'the deterministic verdict still stands');
  });

  it('skips the judge for scenarios that errored', async () => {
    ollama.reset(SOLVE);
    const summary = await runEvals({
      server: { url: 'http://127.0.0.1:1/mcp' },
      models: ['ollama:test-model'],
      scenarios: [SCENARIO],
      judge: { enabled: true },
      reporters: { console: false },
    });

    assert.match(summary.results[0].run.error, /failed/);
    assert.equal(scoreOf(summary.results[0], 'tool_appropriateness'), undefined);
    assert.equal(ollama.requests.length, 0, 'no model call is wasted on an unreachable server');
  });

  it('uses a dedicated judge model when one is configured', async () => {
    ollama.reset([...SOLVE, { content: '{"tool_appropriateness": 1, "answer_satisfies_intent": 1}' }]);
    await runEvals({
      server: { url: mcp.url },
      models: ['ollama:solver-model'],
      scenarios: [SCENARIO],
      judge: { enabled: true, model: 'ollama:judge-model' },
      reporters: { console: false },
    });

    assert.equal(ollama.requests[0].model, 'solver-model');
    assert.equal(ollama.requests.at(-1).model, 'judge-model');
  });
});

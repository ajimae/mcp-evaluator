import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { interpolateEnv, parseConfig, resolveScenario, toModelSpec } from '../dist/index.mjs';

const MINIMAL = { server: { url: 'http://localhost:3000/mcp' } };

describe('parseConfig', () => {
  it('applies defaults so only `server` is mandatory', () => {
    const config = parseConfig(MINIMAL);

    assert.equal(config.server.protocolVersion, '2025-06-18');
    assert.equal(config.server.sendEnabledToolsMeta, false);
    assert.deepEqual(config.server.headers, {});
    assert.equal(config.maxTurns, 5);
    assert.equal(config.judge.enabled, false);
    assert.equal(config.reporters.console, true);
  });

  it('rejects an invalid config with a readable message', () => {
    assert.throws(() => parseConfig({ server: { url: 'not-a-url' } }), /Invalid configuration/);
    assert.throws(
      () =>
        parseConfig({
          ...MINIMAL,
          scenarios: [{ id: 'x', messages: [], expectedToolCalls: [] }],
        }),
      /at least one user message/
    );
  });
});

describe('resolveScenario', () => {
  const base = {
    id: 'search.basic',
    messages: [{ role: 'user', content: 'search for things' }],
  };

  it('infers tool-called when no expected call constrains params', () => {
    const resolved = resolveScenario({ ...base, expectedToolCalls: [{ toolName: 'search' }] }, 5);

    assert.equal(resolved.successCriteria, 'tool-called');
    assert.equal(resolved.toolUnderTest, 'search');
    assert.equal(resolved.maxTurns, 5);
  });

  it('infers tool-called-with once a call constrains params', () => {
    const resolved = resolveScenario(
      { ...base, expectedToolCalls: [{ toolName: 'get', requiredParams: { id: '1' } }] },
      5
    );

    assert.equal(resolved.successCriteria, 'tool-called-with');
  });

  it('infers no-error when nothing is expected, and honours explicit overrides', () => {
    assert.equal(resolveScenario({ ...base, expectedToolCalls: [] }, 5).successCriteria, 'no-error');
    assert.equal(
      resolveScenario(
        { ...base, expectedToolCalls: [{ toolName: 'search' }], successCriteria: 'no-error', maxTurns: 2 },
        5
      ).maxTurns,
      2
    );
  });
});

describe('toModelSpec', () => {
  it('parses provider:modelId, keeping colons in the model id', () => {
    assert.deepEqual(toModelSpec('ollama:llama3.1:8b'), {
      provider: 'ollama',
      modelId: 'llama3.1:8b',
    });
  });

  it('rejects unknown providers and malformed tokens', () => {
    assert.throws(() => toModelSpec('claude-sonnet-5'), /Expected "provider:modelId"/);
    assert.throws(() => toModelSpec('cohere:command'), /Supported providers/);
  });
});

describe('interpolateEnv', () => {
  it('substitutes environment variables and falls back when given a default', () => {
    process.env.MCPEVAL_TEST_TOKEN = 'abc123';
    const source = '{"a":"${MCPEVAL_TEST_TOKEN}","b":"${MCPEVAL_TEST_MISSING:-fallback}"}';

    assert.deepEqual(JSON.parse(interpolateEnv(source)), { a: 'abc123', b: 'fallback' });
    delete process.env.MCPEVAL_TEST_TOKEN;
  });

  it('fails loudly rather than substituting an empty value', () => {
    assert.throws(
      () => interpolateEnv('{"a":"${MCPEVAL_DEFINITELY_UNSET}"}'),
      /MCPEVAL_DEFINITELY_UNSET is referenced in the config but not set/
    );
  });

  it('json-escapes substituted values', () => {
    process.env.MCPEVAL_TEST_QUOTE = 'a"b';
    assert.deepEqual(JSON.parse(interpolateEnv('{"a":"${MCPEVAL_TEST_QUOTE}"}')), { a: 'a"b' });
    delete process.env.MCPEVAL_TEST_QUOTE;
  });
});

describe('resolveScenario with an authored scenario', () => {
  it('accepts a scenario that omits expectedToolCalls entirely', () => {
    // The shape a user writes by hand, fed straight to the low-level pieces without parseConfig.
    const resolved = resolveScenario(
      { id: 'refusal', messages: [{ role: 'user', content: 'Delete everything.' }] },
      5
    );

    assert.deepEqual(resolved.expectedToolCalls, [], 'defaulted rather than left undefined');
    assert.equal(resolved.successCriteria, 'no-error');
    assert.equal(resolved.toolUnderTest, 'refusal', 'falls back to the scenario id');
    assert.equal(resolved.maxTurns, 5);
  });
});

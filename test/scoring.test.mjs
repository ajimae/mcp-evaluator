import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveScenario, scoreScenario } from '../dist/index.mjs';

/** Builds a run with sensible zeroes so each test only states what it cares about. */
function run(overrides = {}) {
  return {
    toolCalls: [],
    turns: 1,
    reachedMaxTurns: false,
    finalText: '',
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    ...overrides,
  };
}

function call(toolName, overrides = {}) {
  return {
    toolName,
    args: {},
    result: {},
    isExpectedTool: true,
    isHallucination: false,
    isError: false,
    latencyMs: 1,
    ...overrides,
  };
}

const scenario = (expectedToolCalls, extra = {}) =>
  resolveScenario(
    {
      id: 'test',
      messages: [{ role: 'user', content: 'do the thing' }],
      expectedToolCalls,
      ...extra,
    },
    5
  );

/** Reads a named score out of the result list. */
const scoreOf = (scores, name) => scores.find((score) => score.name === name)?.value;

describe('scoreScenario', () => {
  it('passes tool-called when the expected tool was called', () => {
    const graded = scoreScenario(scenario([{ toolName: 'search' }]), run({ toolCalls: [call('search')] }));

    assert.equal(graded.passed, true);
    assert.equal(scoreOf(graded.scores, 'correct_tool_selected'), 1);
    assert.equal(scoreOf(graded.scores, 'call_succeeded'), 1);
    assert.equal(scoreOf(graded.scores, 'hallucinated_tool'), 0);
  });

  it('fails when a different tool was called', () => {
    const graded = scoreScenario(
      scenario([{ toolName: 'search' }]),
      run({ toolCalls: [call('other', { isExpectedTool: false })] })
    );

    assert.equal(graded.passed, false);
    assert.equal(scoreOf(graded.scores, 'correct_tool_selected'), 0);
  });

  it('requires the constrained params under tool-called-with', () => {
    const target = scenario([{ toolName: 'get', requiredParams: { id: 'doc-1' } }]);

    const wrong = scoreScenario(target, run({ toolCalls: [call('get', { args: { id: 'doc-2' } })] }));
    assert.equal(wrong.passed, false);
    assert.equal(scoreOf(wrong.scores, 'args_valid'), 0);

    const right = scoreScenario(target, run({ toolCalls: [call('get', { args: { id: 'doc-1' } })] }));
    assert.equal(right.passed, true);
    assert.equal(scoreOf(right.scores, 'args_valid'), 1);
  });

  it('ignores extra arguments alongside the required ones', () => {
    const graded = scoreScenario(
      scenario([{ toolName: 'get', requiredParams: { id: 'doc-1' } }]),
      run({ toolCalls: [call('get', { args: { id: 'doc-1', limit: 10 } })] })
    );

    assert.equal(graded.passed, true);
  });

  it('flags a hallucinated tool and marks the call failed', () => {
    const graded = scoreScenario(
      scenario([{ toolName: 'search' }]),
      run({ toolCalls: [call('imaginary', { isExpectedTool: false, isHallucination: true, isError: true })] })
    );

    assert.equal(scoreOf(graded.scores, 'hallucinated_tool'), 1);
    assert.equal(graded.passed, false);
  });

  it('treats an errored expected call as selected-but-unsuccessful', () => {
    const graded = scoreScenario(
      scenario([{ toolName: 'search' }]),
      run({ toolCalls: [call('search', { isError: true })] })
    );

    assert.equal(scoreOf(graded.scores, 'correct_tool_selected'), 1);
    assert.equal(scoreOf(graded.scores, 'call_succeeded'), 0);
    // tool-called only asks that the right tool was chosen, so this still passes.
    assert.equal(graded.passed, true);
  });

  it('fails no-error scenarios that error, run out of turns, or throw', () => {
    const target = scenario([], { successCriteria: 'no-error' });

    assert.equal(scoreScenario(target, run()).passed, true);
    assert.equal(scoreScenario(target, run({ reachedMaxTurns: true })).passed, false);
    assert.equal(scoreScenario(target, run({ error: 'boom' })).passed, false);
    assert.equal(
      scoreScenario(target, run({ toolCalls: [call('search', { isError: true })] })).passed,
      false
    );
  });
});

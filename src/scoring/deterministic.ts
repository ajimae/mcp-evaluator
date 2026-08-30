import type {
  EvalScore,
  ExpectedToolCall,
  ResolvedScenario,
  ScenarioRun,
  ToolCallRecord,
} from '../types.js';

/**
 * Grades a {@link ScenarioRun} into deterministic, model-agnostic scores. These are the signals that
 * answer "which model finds tool-calling easy vs hard": did it pick the right tool, build valid
 * arguments, succeed, invent a tool that does not exist, and how many turns did it take. Boolean
 * scores carry `value` 0 or 1 so they aggregate cleanly per model.
 */
export function scoreScenario(
  scenario: ResolvedScenario,
  run: ScenarioRun
): { scores: EvalScore[]; passed: boolean } {
  const correctToolSelected = run.toolCalls.some((call) => call.isExpectedTool);
  const argsValid = hasValidArgs(scenario.expectedToolCalls, run.toolCalls);
  const callSucceeded = run.toolCalls.some((call) => call.isExpectedTool && !call.isError);
  const hallucinated = run.toolCalls.some((call) => call.isHallucination);
  const passed = isPass(scenario, run, argsValid);

  const scores: EvalScore[] = [
    booleanScore('correct_tool_selected', correctToolSelected),
    booleanScore('args_valid', argsValid),
    booleanScore('call_succeeded', callSucceeded),
    booleanScore('hallucinated_tool', hallucinated),
    numericScore('total_turns', run.turns, 'Fewer turns = easier for the model'),
    booleanScore('passed', passed),
  ];

  return { scores, passed };
}

function isPass(scenario: ResolvedScenario, run: ScenarioRun, argsValid: boolean): boolean {
  const calledExpectedTool = run.toolCalls.some((call) => call.isExpectedTool);

  switch (scenario.successCriteria) {
    case 'tool-called':
      return calledExpectedTool;
    case 'tool-called-with':
      return calledExpectedTool && argsValid;
    case 'no-error':
      return (
        run.error === undefined &&
        !run.reachedMaxTurns &&
        run.toolCalls.every((call) => !call.isError)
      );
  }
}

/**
 * True when every expected tool call that specifies `requiredParams` is matched by an actual call.
 * When no expected call constrains params, validity reduces to "the expected tool was called".
 */
function hasValidArgs(expected: ExpectedToolCall[], actual: ToolCallRecord[]): boolean {
  const constrained = expected.filter((call) => call.requiredParams !== undefined);
  if (constrained.length === 0) {
    return actual.some((call) => call.isExpectedTool);
  }

  return constrained.every((expectedCall) =>
    actual.some(
      (actualCall) =>
        actualCall.toolName === expectedCall.toolName &&
        matchesParams(actualCall.args, expectedCall.requiredParams ?? {})
    )
  );
}

function matchesParams(args: Record<string, unknown>, required: Record<string, unknown>): boolean {
  return Object.entries(required).every(([key, value]) => deepEquals(args[key], value));
}

function deepEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function booleanScore(name: string, value: boolean): EvalScore {
  return { name, value: value ? 1 : 0, dataType: 'BOOLEAN' };
}

function numericScore(name: string, value: number, comment?: string): EvalScore {
  return { name, value, dataType: 'NUMERIC', ...(comment ? { comment } : {}) };
}

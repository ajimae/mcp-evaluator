import { z } from 'zod';

import type { ModelProvider } from '../providers/types.js';
import type { EvalScore, ResolvedScenario, ScenarioRun } from '../types.js';

/* eslint-disable @typescript-eslint/no-unused-vars -- referenced only by {@link} in JSDoc. */
import type { scoreScenario } from './deterministic.js';
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Optional LLM-as-a-judge scoring. Deterministic scores ({@link scoreScenario}) cover tool
 * selection and argument validity, but cannot judge nuance — whether the chosen tool was
 * *appropriate* when several were valid, or whether the final answer addressed the user's intent.
 * A judge model rates those 0–1. This is off by default (it costs an extra LLM call per run) and is
 * enabled by the orchestrator only when requested.
 */

const judgeVerdictSchema = z.object({
  tool_appropriateness: z.number().min(0).max(1),
  answer_satisfies_intent: z.number().min(0).max(1),
  reasoning: z.string().default(''),
});

type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluator of an AI agent's tool-calling behaviour.
Respond with ONLY a JSON object, no prose, matching exactly:
{"tool_appropriateness": <0-1>, "answer_satisfies_intent": <0-1>, "reasoning": "<short>"}
- tool_appropriateness: did the agent choose suitable tools for the request?
- answer_satisfies_intent: does the final answer address the user's request?`;

/**
 * Scores one run with the judge model. Returns the judge scores, or an empty array if the judge
 * output cannot be parsed (the run is still graded by its deterministic scores).
 */
export async function judgeRun(
  scenario: ResolvedScenario,
  run: ScenarioRun,
  judge: ModelProvider
): Promise<EvalScore[]> {
  const turn = await judge.generateWithTools(
    [{ role: 'user', content: buildJudgePrompt(scenario, run) }],
    [],
    JUDGE_SYSTEM_PROMPT
  );

  const verdict = parseVerdict(turn.textContent);
  return verdict ? toScores(verdict) : [];
}

function buildJudgePrompt(scenario: ResolvedScenario, run: ScenarioRun): string {
  const toolCalls = run.toolCalls.map((call) => ({
    tool: call.toolName,
    args: call.args,
    errored: call.isError,
  }));

  return [
    `User request: ${scenario.messages.map((message) => message.content).join('\n')}`,
    `Tools the agent called: ${JSON.stringify(toolCalls)}`,
    `Final answer: ${run.finalText || '(none)'}`,
  ].join('\n\n');
}

function parseVerdict(text: string): JudgeVerdict | null {
  const json = extractJsonObject(text);
  if (json === null) return null;

  const parsed = judgeVerdictSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Extracts the first JSON object from the judge's reply, tolerating any surrounding prose. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toScores(verdict: JudgeVerdict): EvalScore[] {
  return [
    {
      name: 'tool_appropriateness',
      value: verdict.tool_appropriateness,
      dataType: 'NUMERIC',
      comment: verdict.reasoning || undefined,
    },
    {
      name: 'answer_satisfies_intent',
      value: verdict.answer_satisfies_intent,
      dataType: 'NUMERIC',
    },
  ];
}

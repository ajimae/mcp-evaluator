/**
 * Core types for the MCP tool-calling evaluation harness.
 *
 * The harness poses a natural-language prompt to a real LLM, lets it drive an agentic loop against
 * any MCP server reachable over HTTP (see {@link MCPEvalClient}), and grades the run by what tools
 * were called and whether they succeeded. Scores are computed per run ({@link scoreScenario}) and
 * handed to the configured reporters, tagged by {@link ModelSpec model}.
 *
 * Nothing here is specific to any vendor or MCP server: scenarios, tool names and the server
 * endpoint all come from user configuration.
 */

/* eslint-disable @typescript-eslint/no-unused-vars -- referenced only by {@link} in JSDoc. */
import type { MCPEvalClient } from './mcp/mcp-client.js';
import type { scoreScenario } from './scoring/deterministic.js';
/* eslint-enable @typescript-eslint/no-unused-vars */

/** Relative difficulty label authored on a scenario; surfaced as a reporting dimension. */
export type EvalDifficulty = 'easy' | 'medium' | 'hard';

/** A single user turn that seeds the agentic loop. */
export interface EvalMessage {
  role: 'user';
  content: string;
}

/** A tool call the scenario expects the model to make. */
export interface ExpectedToolCall {
  /** Tool name exactly as the MCP server advertises it in `tools/list`. */
  toolName: string;
  /** Params that MUST appear (partial match) in the call arguments for a `tool-called-with` pass. */
  requiredParams?: Record<string, unknown>;
}

/** How a scenario decides pass/fail. */
export type SuccessCriteriaType = 'tool-called' | 'tool-called-with' | 'no-error';

/**
 * One evaluation scenario: a prompt plus the ground truth used to grade the model's tool use.
 */
export interface EvalScenario {
  /** Unique ID, e.g. `search.by-id`. Used as the reporting key, so keep it stable. */
  id: string;
  /** The tool the scenario is primarily exercising. Defaults to the first expected tool call. */
  toolUnderTest?: string;
  description?: string;
  difficulty?: EvalDifficulty;
  /** Initial conversation sent to the model. */
  messages: EvalMessage[];
  /**
   * Restricts the tools exposed to the model to these names. Omit to expose everything the server
   * advertises. Filtering happens client-side, so it works against any MCP server.
   */
  toolsToEnable?: string[];
  expectedToolCalls: ExpectedToolCall[];
  /** Defaults to `tool-called-with` when any expected call constrains params, else `tool-called`. */
  successCriteria?: SuccessCriteriaType;
  /** Overrides the run-wide system prompt for this scenario. */
  systemPrompt?: string;
  /** Maximum agentic loop turns before giving up. Defaults to the run-wide `maxTurns` (5). */
  maxTurns?: number;
  tags?: string[];
}

/** A scenario with every optional field resolved — what the runner and scorers actually see. */
export interface ResolvedScenario extends EvalScenario {
  toolUnderTest: string;
  successCriteria: SuccessCriteriaType;
  maxTurns: number;
}

/** A single tool invocation made by the model during a run, with its grading flags. */
export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  /** The tool name matches one of the scenario's {@link ExpectedToolCall expected} tools. */
  isExpectedTool: boolean;
  /** The tool name does not exist in the tools exposed to the model. */
  isHallucination: boolean;
  /** The tool returned an MCP error result. */
  isError: boolean;
  latencyMs: number;
}

/** The raw outcome of running one scenario against one model — graded later by {@link scoreScenario}. */
export interface ScenarioRun {
  toolCalls: ToolCallRecord[];
  /** Number of LLM turns taken. */
  turns: number;
  reachedMaxTurns: boolean;
  /** The model's final natural-language answer. */
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock duration of the whole agentic loop. */
  durationMs: number;
  /** Set when the scenario threw instead of completing. */
  error?: string;
}

/** Score data type. We only emit booleans (0/1) and numerics. */
export type ScoreDataType = 'BOOLEAN' | 'NUMERIC';

/** A single graded dimension of a run. Boolean scores carry `value` 0 or 1. */
export interface EvalScore {
  name: string;
  value: number;
  dataType: ScoreDataType;
  comment?: string;
}

/** Provider families the harness can evaluate. `gemini` covers both the Gemini API and Vertex AI. */
export const PROVIDER_NAMES = ['anthropic', 'openai', 'ollama', 'gemini'] as const;
export type ModelProviderName = (typeof PROVIDER_NAMES)[number];

/** Identifies which LLM to evaluate. The harness owns this, so it is always known. */
export interface ModelSpec {
  provider: ModelProviderName;
  modelId: string;
  /** Free-form label used in reports. Defaults to `provider:modelId`. */
  label?: string;
}

/** A scored run of one scenario against one model — the unit handed to reporters. */
export interface ScenarioResult {
  model: ModelSpec;
  scenario: ResolvedScenario;
  run: ScenarioRun;
  scores: EvalScore[];
  passed: boolean;
}

/** `provider:modelId` — the canonical label for a model in reports. */
export function modelLabel(model: ModelSpec): string {
  return model.label ?? `${model.provider}:${model.modelId}`;
}

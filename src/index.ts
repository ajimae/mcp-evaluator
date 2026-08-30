/**
 * mcp-evaluator — a model-agnostic harness that measures how well LLMs call the tools of *any*
 * MCP server reachable over HTTP.
 *
 * Each scenario poses a natural-language prompt to a real model, lets it drive an agentic loop
 * against your server, and grades the run on tool choice, argument construction, success and turn
 * count. Because the harness picks the model rather than inferring it from traffic, every result is
 * attributable to a specific model — which is what makes the comparison meaningful.
 *
 * @example
 * ```ts
 * import { runEvals } from 'mcp-evaluator';
 *
 * const { passRate } = await runEvals({
 *   server: { url: 'http://localhost:3000/mcp' },
 *   models: ['anthropic:claude-sonnet-5', 'openai:gpt-4.1-mini'],
 *   scenarios: [
 *     {
 *       id: 'search.basic',
 *       messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
 *       expectedToolCalls: [{ toolName: 'search' }],
 *     },
 *   ],
 * });
 * ```
 */

export { runEvals } from './run-evals.js';
export type { EvalRunSummary } from './run-evals.js';

export {
  defineConfig,
  parseConfig,
  parseScenarios,
  resolveScenario,
  toModelSpec,
} from './config/config.js';
export type {
  EvalConfig,
  EvalConfigInput,
  EvalScenarioInput,
  JudgeConfig,
  JudgeConfigInput,
  LangfuseReporterConfig,
  LangfuseReporterConfigInput,
  McpServerConfig,
  McpServerConfigInput,
  ReportersConfig,
  ReportersConfigInput,
} from './config/config.js';

export {
  CONFIG_FILENAMES,
  findConfigFile,
  interpolateEnv,
  loadConfigFile,
  loadScenariosFile,
} from './config/load-config.js';

export { MCPEvalClient } from './mcp/mcp-client.js';
export { runAgenticLoop } from './mcp/agentic-loop.js';

export { createProvider } from './providers/provider.factory.js';
export { AnthropicProvider } from './providers/anthropic.provider.js';
export { OpenAIProvider } from './providers/openai.provider.js';
export { GeminiProvider } from './providers/gemini.provider.js';
export { OllamaProvider } from './providers/ollama.provider.js';
export { DEFAULT_SYSTEM_PROMPT } from './providers/default-system-prompt.js';
export type {
  ContentBlock,
  MCPToolDefinition,
  ModelProvider,
  ModelTurn,
  ProviderMessage,
  ToolCallRequest,
} from './providers/types.js';

export { scoreScenario } from './scoring/deterministic.js';
export { judgeRun } from './scoring/llm-judge.js';

export { buildLeaderboard, reportToConsole, toScenarioRow } from './reporting/console.js';
export type { LeaderboardRow, ScenarioRow } from './reporting/console.js';
export { renderMarkdownSummary, writeMarkdownSummary } from './reporting/markdown.js';
export { buildJsonReport, writeJsonReport } from './reporting/json.js';
export type { JsonReport } from './reporting/json.js';
export { reportToLangfuse, resolveLangfuseConfig } from './reporting/langfuse.js';

export { PROVIDER_NAMES, modelLabel } from './types.js';
export type {
  EvalDifficulty,
  EvalMessage,
  EvalScenario,
  EvalScore,
  ExpectedToolCall,
  ModelProviderName,
  ModelSpec,
  ResolvedScenario,
  ScenarioResult,
  ScenarioRun,
  ScoreDataType,
  SuccessCriteriaType,
  ToolCallRecord,
} from './types.js';

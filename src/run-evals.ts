import type { ModelProvider } from './providers/types.js';
import type {
  EvalScore,
  ModelSpec,
  ResolvedScenario,
  ScenarioResult,
  ScenarioRun,
} from './types.js';
import { modelLabel } from './types.js';
import type { EvalConfig, EvalConfigInput } from './config/config.js';
import { parseConfig, resolveScenario, toModelSpec } from './config/config.js';
import { MCPEvalClient } from './mcp/mcp-client.js';
import { runAgenticLoop } from './mcp/agentic-loop.js';
import { createProvider } from './providers/provider.factory.js';
import { scoreScenario } from './scoring/deterministic.js';
import { judgeRun } from './scoring/llm-judge.js';
import { reportToConsole } from './reporting/console.js';
import { writeMarkdownSummary } from './reporting/markdown.js';
import { writeJsonReport } from './reporting/json.js';
import { reportToLangfuse, resolveLangfuseConfig } from './reporting/langfuse.js';

/** The outcome of a full run: every graded result plus the headline numbers the CLI exits on. */
export interface EvalRunSummary {
  results: ScenarioResult[];
  /** Fraction of `model × scenario` runs that passed, 0–1. */
  passRate: number;
  passed: number;
  total: number;
}

/**
 * Runs every scenario against every model, grades each run, and hands the results to the configured
 * reporters.
 *
 * Because the harness owns the model choice — rather than inferring it from production traffic —
 * every result is reliably attributable to a specific model, which is what makes cross-model
 * comparison meaningful.
 */
export async function runEvals(input: EvalConfig | EvalConfigInput): Promise<EvalRunSummary> {
  const config = parseConfig(input);
  const models = config.models.map(toModelSpec);
  const scenarios = config.scenarios.map((scenario) => resolveScenario(scenario, config.maxTurns));

  if (models.length === 0) {
    throw new Error('No models to evaluate. Add `models` to your config or pass them on the CLI.');
  }
  if (scenarios.length === 0) {
    throw new Error('No scenarios to run. Add `scenarios` to your config or pass --scenarios.');
  }

  const judge = await resolveJudge(config, models);
  const results: ScenarioResult[] = [];

  for (const model of models) {
    const provider = await createProvider(model);
    for (const scenario of scenarios) {
      results.push(await evaluate(scenario, model, provider, config, judge));
    }
  }

  await report(results, config);
  return summarize(results);
}

async function evaluate(
  scenario: ResolvedScenario,
  model: ModelSpec,
  provider: ModelProvider,
  config: EvalConfig,
  judge: ModelProvider | null
): Promise<ScenarioResult> {
  const run = await runScenario(scenario, provider, config);
  const graded = scoreScenario(scenario, run);
  const judgeScores = judge && run.error === undefined ? await judgeSafely(scenario, run, judge) : [];

  return {
    model,
    scenario,
    run,
    scores: graded.scores.concat(judgeScores),
    passed: graded.passed,
  };
}

/**
 * Executes one scenario end to end. A thrown scenario is recorded as a failed run rather than
 * rethrown, so one unreachable tool or rate-limited model does not sink the whole run — and the
 * report still shows what happened.
 */
async function runScenario(
  scenario: ResolvedScenario,
  provider: ModelProvider,
  config: EvalConfig
): Promise<ScenarioRun> {
  const startedAt = Date.now();
  const mcpClient = new MCPEvalClient(config.server);

  try {
    await mcpClient.connect(scenario.toolsToEnable);
    return await runAgenticLoop(scenario, provider, mcpClient, config.systemPrompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ ${scenario.id}: ${message}`);
    return {
      toolCalls: [],
      turns: 0,
      reachedMaxTurns: false,
      finalText: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  } finally {
    await mcpClient.disconnect();
  }
}

/** A judge failure must not fail the run — the deterministic scores still stand on their own. */
async function judgeSafely(
  scenario: ResolvedScenario,
  run: ScenarioRun,
  judge: ModelProvider
): Promise<EvalScore[]> {
  try {
    return await judgeRun(scenario, run, judge);
  } catch (error) {
    console.warn(
      `  ! judge failed for ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

async function report(results: ScenarioResult[], config: EvalConfig): Promise<void> {
  const { reporters } = config;

  if (reporters.console) reportToConsole(results);
  if (reporters.markdown) writeMarkdownSummary(results, reporters.markdown);
  if (reporters.json) writeJsonReport(results, reporters.json);

  const langfuse = resolveLangfuseConfig(reporters);
  if (langfuse) await reportToLangfuse(results, langfuse);
}

/** Defaults the judge to the first evaluated model, so `judge: { enabled: true }` needs no extra config. */
async function resolveJudge(config: EvalConfig, models: ModelSpec[]): Promise<ModelProvider | null> {
  if (!config.judge.enabled) return null;

  const spec = config.judge.model ? toModelSpec(config.judge.model) : models[0];
  if (!spec) return null;

  console.log(`Using ${modelLabel(spec)} as the LLM judge.`);
  return createProvider(spec);
}

function summarize(results: ScenarioResult[]): EvalRunSummary {
  const passed = results.filter((result) => result.passed).length;
  return {
    results,
    passed,
    total: results.length,
    passRate: results.length > 0 ? passed / results.length : 0,
  };
}

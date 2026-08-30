import { writeFileSync } from 'node:fs';

import type { ScenarioResult } from '../types.js';
import { modelLabel } from '../types.js';
import { buildLeaderboard } from './console.js';

/** The machine-readable report written by the `json` reporter — stable enough to diff across runs. */
export interface JsonReport {
  generatedAt: string;
  summary: {
    scenarios: number;
    models: number;
    passed: number;
    passRate: number;
  };
  leaderboard: ReturnType<typeof buildLeaderboard>;
  results: Array<{
    model: string;
    provider: string;
    modelId: string;
    scenario: string;
    description?: string;
    difficulty?: string;
    tags?: string[];
    passed: boolean;
    turns: number;
    reachedMaxTurns: boolean;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    finalText: string;
    error?: string;
    scores: Record<string, number>;
    toolCalls: Array<{
      toolName: string;
      args: Record<string, unknown>;
      isExpectedTool: boolean;
      isHallucination: boolean;
      isError: boolean;
      latencyMs: number;
    }>;
  }>;
}

/** Builds the full report object. Exported so library users can post-process without a file. */
export function buildJsonReport(results: ScenarioResult[]): JsonReport {
  const passed = results.filter((result) => result.passed).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      scenarios: new Set(results.map((result) => result.scenario.id)).size,
      models: new Set(results.map((result) => modelLabel(result.model))).size,
      passed,
      passRate: results.length > 0 ? passed / results.length : 0,
    },
    leaderboard: buildLeaderboard(results),
    results: results.map(toJsonResult),
  };
}

/** Writes the machine-readable report to `path`. */
export function writeJsonReport(results: ScenarioResult[], path: string): void {
  writeFileSync(path, `${JSON.stringify(buildJsonReport(results), null, 2)}\n`, 'utf8');
  console.log(`Wrote JSON report to ${path}`);
}

function toJsonResult(result: ScenarioResult): JsonReport['results'][number] {
  return {
    model: modelLabel(result.model),
    provider: result.model.provider,
    modelId: result.model.modelId,
    scenario: result.scenario.id,
    ...(result.scenario.description ? { description: result.scenario.description } : {}),
    ...(result.scenario.difficulty ? { difficulty: result.scenario.difficulty } : {}),
    ...(result.scenario.tags ? { tags: result.scenario.tags } : {}),
    passed: result.passed,
    turns: result.run.turns,
    reachedMaxTurns: result.run.reachedMaxTurns,
    durationMs: result.run.durationMs,
    inputTokens: result.run.inputTokens,
    outputTokens: result.run.outputTokens,
    finalText: result.run.finalText,
    ...(result.run.error ? { error: result.run.error } : {}),
    scores: Object.fromEntries(result.scores.map((score) => [score.name, score.value])),
    toolCalls: result.run.toolCalls.map((call) => ({
      toolName: call.toolName,
      args: call.args,
      isExpectedTool: call.isExpectedTool,
      isHallucination: call.isHallucination,
      isError: call.isError,
      latencyMs: call.latencyMs,
    })),
  };
}

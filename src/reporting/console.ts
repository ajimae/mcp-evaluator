import type { ScenarioResult } from '../types.js';
import { modelLabel } from '../types.js';

/**
 * Prints a simple metric display to the console — the default reporter. Shows a per-model
 * leaderboard (pass rate, average turns, tokens) plus a per-scenario breakdown, so "which model
 * finds this easy vs hard" is readable at a glance. Intentionally plain: no files, no colours.
 */
export function reportToConsole(results: ScenarioResult[]): void {
  if (results.length === 0) {
    console.log('No eval results to report.');
    return;
  }

  console.log('\n=== Model leaderboard ===');
  console.table(buildLeaderboard(results));

  console.log('\n=== Per-scenario results ===');
  console.table(results.map(toScenarioRow));

  reportErrors(results);
}

/** Surfaces scenarios that threw, so an infrastructure problem is not mistaken for a model failure. */
function reportErrors(results: ScenarioResult[]): void {
  const errored = results.filter((result) => result.run.error !== undefined);
  if (errored.length === 0) return;

  console.log('\n=== Errors ===');
  for (const result of errored) {
    console.log(`  ${modelLabel(result.model)} / ${result.scenario.id}: ${result.run.error ?? ''}`);
  }
}

export interface LeaderboardRow {
  model: string;
  scenarios: number;
  passed: number;
  pass_rate: string;
  avg_turns: string;
  avg_latency_ms: number;
  total_tokens: number;
}

export function buildLeaderboard(results: ScenarioResult[]): LeaderboardRow[] {
  const byModel = groupByModel(results);
  return [...byModel.entries()].map(([label, group]) => modelGroupToRow(label, group));
}

function groupByModel(results: ScenarioResult[]): Map<string, ScenarioResult[]> {
  const groups = new Map<string, ScenarioResult[]>();
  for (const result of results) {
    const label = modelLabel(result.model);
    groups.set(label, (groups.get(label) ?? []).concat(result));
  }
  return groups;
}

function modelGroupToRow(label: string, group: ScenarioResult[]): LeaderboardRow {
  const passed = group.filter((result) => result.passed).length;
  const avgTurns = average(group.map((result) => result.run.turns));
  const avgLatency = average(group.map((result) => result.run.durationMs));
  const tokens = group.reduce(
    (total, result) => total + result.run.inputTokens + result.run.outputTokens,
    0
  );
  return {
    model: label,
    scenarios: group.length,
    passed,
    pass_rate: toPercent(passed / group.length),
    avg_turns: avgTurns.toFixed(1),
    avg_latency_ms: Math.round(avgLatency),
    total_tokens: tokens,
  };
}

export interface ScenarioRow {
  scenario: string;
  model: string;
  passed: boolean;
  [score: string]: string | number | boolean;
}

export function toScenarioRow(result: ScenarioResult): ScenarioRow {
  // No raw `turns` column: the `total_turns` score (spread in below) already carries it.
  const row: ScenarioRow = {
    scenario: result.scenario.id,
    model: modelLabel(result.model),
    passed: result.passed,
  };
  for (const score of result.scores) {
    row[score.name] = score.value;
  }
  return row;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function toPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

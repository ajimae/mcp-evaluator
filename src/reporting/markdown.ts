import { writeFileSync } from 'node:fs';

import type { ScenarioResult } from '../types.js';
import { buildLeaderboard, toScenarioRow } from './console.js';

/**
 * Renders the eval results as a Markdown summary (leaderboard + per-scenario tables) — the format
 * to paste into a CI job summary or a PR comment.
 */
export function renderMarkdownSummary(results: ScenarioResult[], title = 'MCP tool-calling evals'): string {
  if (results.length === 0) {
    return `### ${title}\n\nNo eval results to report.`;
  }

  const leaderboard = renderTable(
    ['model', 'scenarios', 'passed', 'pass_rate', 'avg_turns', 'avg_latency_ms', 'total_tokens'],
    buildLeaderboard(results).map((row) => [
      row.model,
      row.scenarios,
      row.passed,
      row.pass_rate,
      row.avg_turns,
      row.avg_latency_ms,
      row.total_tokens,
    ])
  );

  const scenarioRows = results.map(toScenarioRow);
  const scoreKeys = collectScoreKeys(scenarioRows);
  const perScenario = renderTable(
    ['scenario', 'model', 'passed', ...scoreKeys],
    scenarioRows.map((row) => [
      row.scenario,
      row.model,
      row.passed ? '✅' : '❌',
      ...scoreKeys.map((key) => row[key] ?? ''),
    ])
  );

  return [
    `### ${title}`,
    '',
    '**Leaderboard**',
    '',
    leaderboard,
    '',
    '**Per-scenario**',
    '',
    perScenario,
    '',
    ...renderErrors(results),
  ].join('\n');
}

/** Writes the Markdown summary to `path`. */
export function writeMarkdownSummary(results: ScenarioResult[], path: string, title?: string): void {
  writeFileSync(path, renderMarkdownSummary(results, title), 'utf8');
  console.log(`Wrote Markdown summary to ${path}`);
}

function renderErrors(results: ScenarioResult[]): string[] {
  const errored = results.filter((result) => result.run.error !== undefined);
  if (errored.length === 0) return [];

  return [
    '<details><summary>Errors</summary>',
    '',
    ...errored.map(
      (result) =>
        `- \`${result.model.provider}:${result.model.modelId}\` / \`${result.scenario.id}\`: ${result.run.error ?? ''}`
    ),
    '',
    '</details>',
    '',
  ];
}

/** Collects the union of score-column names across rows, preserving first-seen order. */
function collectScoreKeys(rows: ReturnType<typeof toScenarioRow>[]): string[] {
  const fixed = new Set(['scenario', 'model', 'passed']);
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!fixed.has(key) && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function renderTable(headers: string[], rows: (string | number | boolean)[][]): string {
  const headerLine = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((cells) => `| ${cells.map((cell) => String(cell)).join(' | ')} |`);
  return [headerLine, separator, ...bodyLines].join('\n');
}

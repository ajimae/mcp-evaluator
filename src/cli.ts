#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { EvalConfig } from './config/config.js';
import { toModelSpec } from './config/config.js';
import { CONFIG_FILENAMES, findConfigFile, loadConfigFile, loadScenariosFile } from './config/load-config.js';
import { runEvals } from './run-evals.js';
import { modelLabel } from './types.js';
import {
  DEFAULT_CONFIG_FILENAME,
  SUPPORTED_CONFIG_EXTENSIONS,
  detectConfigFormat,
  renderConfigTemplate,
} from './templates/config-template.js';

/**
 * CLI entrypoint. Reads `mcpeval.config.*` (or `--config`), applies command-line overrides, runs
 * the suite, and exits non-zero when the pass rate falls below `--fail-under`.
 */

/**
 * Package version, substituted by the bundler (see the `define` in `esbuild.cjs`).
 *
 * Injected rather than read from `package.json` at runtime: locating that file would need
 * `import.meta.url`, which is unavailable in the CommonJS bundle, and the alternatives are all
 * format-specific. A build-time constant is correct in every output format and saves a file read.
 */
declare const __MCP_EVALUATOR_VERSION__: string | undefined;

const VERSION =
  typeof __MCP_EVALUATOR_VERSION__ === 'string' ? __MCP_EVALUATOR_VERSION__ : '0.0.0-dev';

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  url: { type: 'string', short: 'u' },
  header: { type: 'string', short: 'H', multiple: true },
  scenarios: { type: 'string', short: 's' },
  model: { type: 'string', short: 'm', multiple: true },
  scenario: { type: 'string', multiple: true },
  tag: { type: 'string', multiple: true },
  judge: { type: 'boolean' },
  'judge-model': { type: 'string' },
  'max-turns': { type: 'string' },
  markdown: { type: 'string' },
  json: { type: 'string' },
  langfuse: { type: 'boolean' },
  'fail-under': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  list: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'init') return init(argv[1]);

  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });

  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }

  const config = await applyOverrides(await loadConfig(values.config), values, positionals);
  if (values.list) {
    printPlan(config);
    return 0;
  }

  const summary = await runEvals(config);
  const failUnder = config.failUnder;
  if (failUnder !== undefined && summary.passRate * 100 < failUnder) {
    console.error(
      `\nPass rate ${(summary.passRate * 100).toFixed(1)}% is below the --fail-under threshold of ${failUnder}%.`
    );
    return 1;
  }
  return 0;
}

/** Loads the config from `--config`, or discovers one in the working directory. */
async function loadConfig(explicitPath?: string): Promise<EvalConfig> {
  if (explicitPath) return loadConfigFile(explicitPath);

  const discovered = findConfigFile();
  if (!discovered) {
    throw new Error(
      `No config file found. Looked for: ${CONFIG_FILENAMES.join(', ')}.\n` +
        'Run `mcp-evaluator init` to create one, or pass --config <path>.'
    );
  }
  console.log(`Using config ${discovered}`);
  return loadConfigFile(discovered);
}

type CliValues = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

/** Merges CLI flags over the file config. Flags always win; unset flags leave the file value alone. */
async function applyOverrides(
  config: EvalConfig,
  values: CliValues,
  positionals: string[]
): Promise<EvalConfig> {
  const models = [...positionals, ...(values.model ?? [])];
  const scenarios = values.scenarios
    ? await loadScenariosFile(values.scenarios)
    : config.scenarios;

  const merged: EvalConfig = {
    ...config,
    server: {
      ...config.server,
      ...(values.url ? { url: values.url } : {}),
      headers: { ...config.server.headers, ...parseHeaders(values.header ?? []) },
    },
    ...(models.length > 0 ? { models: models.map(toModelSpec) } : {}),
    ...(values['max-turns'] ? { maxTurns: parseNumber(values['max-turns'], '--max-turns') } : {}),
    judge: {
      enabled: values.judge === true || Boolean(values['judge-model']) || config.judge.enabled,
      ...(values['judge-model']
        ? { model: values['judge-model'] }
        : config.judge.model
          ? { model: config.judge.model }
          : {}),
    },
    reporters: {
      ...config.reporters,
      ...(values.quiet ? { console: false } : {}),
      ...(values.markdown ? { markdown: values.markdown } : {}),
      ...(values.json ? { json: values.json } : {}),
      ...(values.langfuse ? { langfuse: true as const } : {}),
    },
    ...(values['fail-under']
      ? { failUnder: parseNumber(values['fail-under'], '--fail-under') }
      : {}),
  };

  merged.scenarios = filterScenarios(scenarios, values.scenario, values.tag);
  return merged;
}

/** Narrows the suite to the requested scenario ids and/or tags. Both filters are additive within, ANDed across. */
function filterScenarios(
  scenarios: EvalConfig['scenarios'],
  ids?: string[],
  tags?: string[]
): EvalConfig['scenarios'] {
  let filtered = scenarios;
  if (ids && ids.length > 0) {
    const wanted = new Set(ids);
    filtered = filtered.filter((scenario) => wanted.has(scenario.id));
    const missing = ids.filter((id) => !scenarios.some((scenario) => scenario.id === id));
    if (missing.length > 0) {
      throw new Error(`Unknown scenario id(s): ${missing.join(', ')}`);
    }
  }
  if (tags && tags.length > 0) {
    const wanted = new Set(tags);
    filtered = filtered.filter((scenario) => scenario.tags?.some((tag) => wanted.has(tag)));
  }
  return filtered;
}

function parseHeaders(raw: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw) {
    const separator = entry.indexOf(':');
    if (separator === -1) {
      throw new Error(`Invalid --header "${entry}". Expected "Name: value".`);
    }
    headers[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return headers;
}

function parseNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${flag} "${raw}". Expected a number.`);
  return value;
}

/** `--list`: show what a run would do, without spending a single token. */
function printPlan(config: EvalConfig): void {
  console.log(`\nServer:    ${config.server.url}`);
  console.log(`Models:    ${config.models.map((m) => modelLabel(toModelSpec(m))).join(', ') || '(none)'}`);
  console.log(`Judge:     ${config.judge.enabled ? 'enabled' : 'disabled'}`);
  console.log(`\nScenarios (${config.scenarios.length}):`);
  for (const scenario of config.scenarios) {
    const tools = scenario.expectedToolCalls.map((call) => call.toolName).join(', ') || '—';
    console.log(`  ${scenario.id}  [${scenario.difficulty ?? 'unrated'}]  → ${tools}`);
  }
  console.log(`\nTotal runs: ${config.models.length * config.scenarios.length}`);
}

/**
 * `mcp-evaluator init`: writes a starter config next to the user's project, in the syntax implied
 * by the filename — `init mcpeval.config.json` must produce JSON, not an ES module.
 */
function init(target?: string): number {
  const path = resolve(process.cwd(), target ?? DEFAULT_CONFIG_FILENAME);
  const name = basename(path);

  // Only scaffold names `findConfigFile` discovers. Otherwise `init` writes a config that a bare
  // `mcp-evaluator` never picks up, and the user has to pass --config forever without knowing why.
  if (!isDiscoverableConfigName(name)) {
    console.error(unknownNameMessage(name));
    return 1;
  }

  const format = detectConfigFormat(path, packageTypeOf(process.cwd()));
  if (format === null) {
    console.error(
      `Cannot scaffold "${name}": unsupported config extension.\n` +
        `Supported: ${SUPPORTED_CONFIG_EXTENSIONS.join(', ')}`
    );
    return 1;
  }

  if (existsSync(path)) {
    console.error(`${path} already exists — refusing to overwrite it.`);
    return 1;
  }

  writeFileSync(path, renderConfigTemplate(format), 'utf8');
  console.log(`Created ${path} (${format})`);
  console.log('Edit the server URL and scenarios, then run: npx mcp-evaluator');
  return 0;
}

/** True when `name` is one of the filenames {@link findConfigFile} looks for. */
function isDiscoverableConfigName(name: string): boolean {
  return (CONFIG_FILENAMES as readonly string[]).includes(name);
}

/** Explains the naming rule, and suggests the right filename when the extension itself was fine. */
function unknownNameMessage(name: string): string {
  const lines = [
    `Cannot scaffold "${name}": a config must use a name the CLI can discover.`,
    `Valid names: ${CONFIG_FILENAMES.join(', ')}`,
  ];

  const extension = name.slice(name.lastIndexOf('.'));
  const suggestion = name.includes('.')
    ? CONFIG_FILENAMES.find((candidate) => candidate.endsWith(extension))
    : undefined;
  if (suggestion) {
    lines.push(`Did you mean:  mcp-evaluator init ${suggestion}`);
  }
  lines.push('To use another name, write the file yourself and pass --config <path>.');

  return lines.join('\n');
}

/**
 * Reads `type` from the project's package.json. A bare `.js` config is ESM or CommonJS depending
 * on it, so the scaffold has to match or the config will not load.
 */
function packageTypeOf(cwd: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as {
      type?: unknown;
    };
    return typeof raw.type === 'string' ? raw.type : undefined;
  } catch {
    // No package.json, or unreadable — Node would treat a .js file as CommonJS, and so do we.
    return undefined;
  }
}

function usage(): string {
  return `mcp-evaluator — measure how well LLMs call your MCP server's tools

Usage:
  mcp-evaluator [options] [provider:modelId ...]
  mcp-evaluator init [name]     Scaffold a config. The name must be one the CLI can discover;
                                its extension picks the format.
                                ${CONFIG_FILENAMES.join(', ')}

Options:
  -c, --config <path>       Config file (default: ${CONFIG_FILENAMES[0]}, .js, .mjs, .json, ...)
  -u, --url <url>           MCP server endpoint (overrides the config)
  -H, --header <name: val>  Extra request header; repeatable
  -s, --scenarios <path>    Load scenarios from a separate file (overrides the config)
  -m, --model <spec>        Model to evaluate as provider:modelId; repeatable
      --scenario <id>       Only run these scenario ids; repeatable
      --tag <tag>           Only run scenarios carrying one of these tags; repeatable
      --judge               Add the LLM-as-a-judge scores
      --judge-model <spec>  Model to judge with (implies --judge)
      --max-turns <n>       Default agentic-loop turn budget
      --markdown <path>     Write a Markdown summary
      --json <path>         Write the full results as JSON
      --langfuse            Export traces and scores to Langfuse
      --fail-under <pct>    Exit 1 when the pass rate is below this percentage
      --list                Print the run plan and exit
  -q, --quiet               Suppress the console tables
  -h, --help                Show this help
  -v, --version             Show the version

Providers: anthropic, openai, gemini, ollama (credentials come from the usual env vars).

Examples:
  mcp-evaluator init
  mcp-evaluator init mcpeval.config.json
  mcp-evaluator anthropic:claude-sonnet-5 openai:gpt-4.1-mini
  mcp-evaluator --url http://localhost:3000/mcp --tag read --judge
  mcp-evaluator --json results.json --fail-under 80
`;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { EvalScenario } from '../types.js';
import { parseConfig, parseScenarios } from './config.js';
import type { EvalConfig } from './config.js';

/**
 * Locating and loading the user's config. Config may be JS/TS (a module default-exporting the
 * config) or JSON. JSON gets `${ENV_VAR}` interpolation so secrets stay out of the file; JS/TS
 * configs can just read `process.env` directly.
 */

/** Config filenames looked up, in order, when `--config` is not given. */
export const CONFIG_FILENAMES = [
  'mcpeval.config.ts',
  'mcpeval.config.mts',
  'mcpeval.config.js',
  'mcpeval.config.mjs',
  'mcpeval.config.cjs',
  'mcpeval.config.json',
  '.mcpevalrc',
] as const;

/**
 * Extensionless rc files that are nonetheless JSON, following the `.babelrc` / `.eslintrc`
 * convention. Matched on the basename, so `.mcpevalrc` is parsed as JSON rather than imported as
 * a module — importing it would fail, since Node cannot infer a loader for a file with no
 * extension.
 */
export const EXTENSIONLESS_JSON_CONFIGS: readonly string[] = ['.mcpevalrc'];

/** True when `path` should be read as JSON (with `${ENV}` interpolation) rather than imported. */
function isJsonConfig(path: string): boolean {
  return path.endsWith('.json') || EXTENSIONLESS_JSON_CONFIGS.includes(basename(path));
}

/** Returns the first config file present in `cwd`, or `null` if there is none. */
export function findConfigFile(cwd: string = process.cwd()): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, filename);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Loads and validates the config at `path`. */
export async function loadConfigFile(path: string): Promise<EvalConfig> {
  return parseConfig(await loadFile(path));
}

/** Loads and validates a standalone scenarios file (array, `{ scenarios: [...] }`, or default export). */
export async function loadScenariosFile(path: string): Promise<EvalScenario[]> {
  return parseScenarios(await loadFile(path));
}

/** Reads a JS/TS/JSON file into a plain value, unwrapping a `default` export when present. */
async function loadFile(path: string): Promise<unknown> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) {
    throw new Error(`Config file not found: ${absolute}`);
  }

  return isJsonConfig(absolute) ? loadJsonFile(absolute) : loadModuleFile(absolute);
}

async function loadJsonFile(absolute: string): Promise<unknown> {
  const source = interpolateEnv(await readFile(absolute, 'utf8'));
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Failed to parse ${absolute} as JSON: ${messageOf(error)}`);
  }
}

async function loadModuleFile(absolute: string): Promise<unknown> {
  let module: Record<string, unknown>;
  try {
    // Cache-bust so repeated in-process loads (tests, watch mode) see edits.
    module = (await import(`${pathToFileURL(absolute).href}?t=${Date.now()}`)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(describeImportFailure(absolute, error));
  }

  return 'default' in module ? module['default'] : module;
}

/**
 * TypeScript configs only load on a runtime that can execute TS (Bun, tsx, or Node with type
 * stripping). Say so plainly instead of leaking `ERR_UNKNOWN_FILE_EXTENSION`.
 */
function describeImportFailure(absolute: string, error: unknown): string {
  const message = messageOf(error);
  const isTypeScript = /\.m?ts$/.test(absolute);
  if (isTypeScript && /Unknown file extension|Cannot find module|strip-types/i.test(message)) {
    return (
      `Failed to load the TypeScript config ${absolute}: ${message}\n` +
      'Run mcp-evaluator under a TypeScript-capable runtime (`bun`, `tsx`, or Node >=22.6 with ' +
      '`--experimental-strip-types`), or use mcpeval.config.mjs / mcpeval.config.json instead.'
    );
  }

  return `Failed to load config ${absolute}: ${message}`;
}

/**
 * Expands `${VAR}` and `${VAR:-fallback}` in JSON config text. An unset variable with no fallback
 * is an error rather than an empty string — a silently blank auth header is worse than a crash.
 */
export function interpolateEnv(source: string): string {
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
    const value = process.env[name as string];
    if (value !== undefined && value !== '') return escapeForJson(value);
    if (fallback !== undefined) return escapeForJson(fallback as string);
    throw new Error(`Environment variable ${String(name)} is referenced in the config but not set.`);
  });
}

/** Values are substituted inside JSON string literals, so they must be JSON-escaped. */
function escapeForJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

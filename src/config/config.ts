import { z } from 'zod';

import { PROVIDER_NAMES } from '../types.js';
import type {
  EvalScenario,
  ExpectedToolCall,
  ModelSpec,
  ResolvedScenario,
  SuccessCriteriaType,
} from '../types.js';

/**
 * User-facing configuration: what server to evaluate, which models to evaluate it with, and which
 * scenarios to run. Everything the harness needs comes from here (or CLI overrides) — the package
 * ships no built-in server, tool names or scenarios.
 *
 * Validated with zod so a hand-written JSON/JS config fails loudly and early rather than midway
 * through a paid eval run.
 */

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;

const modelSpecSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  modelId: z.string().min(1),
  label: z.string().min(1).optional(),
});

/** A model is either a `provider:modelId` string or an explicit {@link ModelSpec}. */
const modelRefSchema = z.union([z.string().min(1), modelSpecSchema]);

const successCriteriaSchema = z.enum(['tool-called', 'tool-called-with', 'no-error']);

const expectedToolCallSchema = z.object({
  toolName: z.string().min(1),
  requiredParams: z.record(z.string(), z.unknown()).optional(),
});

const scenarioSchema = z.object({
  id: z.string().min(1),
  toolUnderTest: z.string().min(1).optional(),
  description: z.string().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  messages: z
    .array(z.object({ role: z.literal('user'), content: z.string().min(1) }))
    .min(1, 'a scenario needs at least one user message'),
  toolsToEnable: z.array(z.string().min(1)).optional(),
  expectedToolCalls: z.array(expectedToolCallSchema).default([]),
  successCriteria: successCriteriaSchema.optional(),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
});

const serverSchema = z.object({
  /** Full URL of the MCP endpoint, e.g. `http://localhost:3000/mcp`. */
  url: z.string().url(),
  /** Static headers sent on every request — put bearer tokens, API keys or tenant ids here. */
  headers: z.record(z.string(), z.string()).default({}),
  /** MCP protocol version advertised during `initialize`. */
  protocolVersion: z.string().default(DEFAULT_PROTOCOL_VERSION),
  clientInfo: z
    .object({ name: z.string().min(1), version: z.string().min(1) })
    .default({ name: 'mcp-evaluator', version: '1.0.0' }),
  /** Extra `_meta` merged into every request's `params` — for servers/gateways that require it. */
  requestMeta: z.record(z.string(), z.unknown()).default({}),
  /**
   * Also send each scenario's `toolsToEnable` as `_meta.tools`. Off by default: plain MCP servers
   * ignore it and the harness filters the advertised tool list client-side anyway. Turn it on for
   * gateways that gate tools server-side.
   */
  sendEnabledToolsMeta: z.boolean().default(false),
  /** Per-request timeout. */
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
});

const langfuseSchema = z.object({
  enabled: z.boolean().default(true),
  publicKey: z.string().optional(),
  secretKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  /** Only export when running on CI (`CI` env var set). Defaults to false — export whenever enabled. */
  onlyOnCi: z.boolean().default(false),
});

const reportersSchema = z.object({
  /** Print the leaderboard + per-scenario tables. Default true. */
  console: z.boolean().default(true),
  /** Write a Markdown summary to this path (handy as a CI PR comment). */
  markdown: z.string().min(1).optional(),
  /** Write the full machine-readable results to this path. */
  json: z.string().min(1).optional(),
  /** Export traces and scores to Langfuse. Requires the optional Langfuse peer dependencies. */
  langfuse: z.union([z.boolean(), langfuseSchema]).optional(),
});

const judgeSchema = z.object({
  enabled: z.boolean().default(false),
  /** Model used as the judge. Defaults to the first evaluated model. */
  model: modelRefSchema.optional(),
});

const evalConfigSchema = z.object({
  server: serverSchema,
  models: z.array(modelRefSchema).default([]),
  scenarios: z.array(scenarioSchema).default([]),
  /** Default system prompt for every scenario that does not set its own. */
  systemPrompt: z.string().optional(),
  /** Default agentic-loop turn budget. Scenarios may override. */
  maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
  judge: judgeSchema.default({ enabled: false }),
  reporters: reportersSchema.default({ console: true }),
  /** Exit non-zero when the overall pass rate (percent) falls below this. */
  failUnder: z.number().min(0).max(100).optional(),
});

/**
 * The public config types are written out by hand rather than inferred from the zod schemas above.
 *
 * zod is bundled into the published output and is *not* a runtime dependency, so a `z.input<...>`
 * alias would put `import { z } from 'zod'` in the emitted .d.ts and force every TypeScript
 * consumer to install zod — and under the common `skipLibCheck: true`, silently degrade these
 * types to `any` instead of erroring. Hand-written interfaces keep the public surface
 * self-contained. {@link _ConfigTypesMatchSchema} stops the two drifting apart.
 */

/** MCP endpoint settings as written by the user. */
export interface McpServerConfigInput {
  /** Full URL of the MCP endpoint, e.g. `http://localhost:3000/mcp`. */
  url: string;
  /** Static headers sent on every request — bearer tokens, API keys, tenant ids. */
  headers?: Record<string, string>;
  /** MCP protocol version advertised during `initialize`. Defaults to `2025-06-18`. */
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
  /** Extra `_meta` merged into every request's `params`, for servers that require it. */
  requestMeta?: Record<string, unknown>;
  /** Also send each scenario's `toolsToEnable` as `_meta.tools`. Defaults to `false`. */
  sendEnabledToolsMeta?: boolean;
  /** Per-request timeout in ms. Defaults to 60000. */
  timeoutMs?: number;
}

/** MCP endpoint settings with defaults applied. */
export interface McpServerConfig {
  url: string;
  headers: Record<string, string>;
  protocolVersion: string;
  clientInfo: { name: string; version: string };
  requestMeta: Record<string, unknown>;
  sendEnabledToolsMeta: boolean;
  timeoutMs: number;
}

export interface LangfuseReporterConfigInput {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  /** Only export when running on CI. Defaults to `false`. */
  onlyOnCi?: boolean;
}

export interface LangfuseReporterConfig {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  onlyOnCi: boolean;
}

export interface ReportersConfigInput {
  /** Print the leaderboard + per-scenario tables. Defaults to `true`. */
  console?: boolean;
  /** Write a Markdown summary to this path. */
  markdown?: string;
  /** Write the full machine-readable results to this path. */
  json?: string;
  /** Export traces and scores to Langfuse. Needs the optional Langfuse peer dependencies. */
  langfuse?: boolean | LangfuseReporterConfigInput;
}

export interface ReportersConfig {
  console: boolean;
  markdown?: string;
  json?: string;
  langfuse?: boolean | LangfuseReporterConfig;
}

export interface JudgeConfigInput {
  enabled?: boolean;
  /** Model used as the judge. Defaults to the first evaluated model. */
  model?: string | ModelSpec;
}

export interface JudgeConfig {
  enabled: boolean;
  model?: string | ModelSpec;
}

/** A scenario as authored: `expectedToolCalls` may be omitted and defaults to `[]`. */
export type EvalScenarioInput = Omit<EvalScenario, 'expectedToolCalls'> & {
  expectedToolCalls?: ExpectedToolCall[];
};

/** The shape a user writes in `mcpeval.config.*` — every field but `server` is optional. */
export interface EvalConfigInput {
  server: McpServerConfigInput;
  /** `provider:modelId` strings or explicit specs. CLI arguments override this. */
  models?: (string | ModelSpec)[];
  scenarios?: EvalScenarioInput[];
  /** Default system prompt for every scenario that does not set its own. */
  systemPrompt?: string;
  /** Default agentic-loop turn budget. Scenarios may override. Defaults to 5. */
  maxTurns?: number;
  judge?: JudgeConfigInput;
  reporters?: ReportersConfigInput;
  /** Exit non-zero when the overall pass rate (percent) falls below this. */
  failUnder?: number;
}

/** A validated config with defaults applied — what the runner and reporters consume. */
export interface EvalConfig {
  server: McpServerConfig;
  models: (string | ModelSpec)[];
  scenarios: EvalScenario[];
  systemPrompt?: string;
  maxTurns: number;
  judge: JudgeConfig;
  reporters: ReportersConfig;
  failUnder?: number;
}

/**
 * Compile-time guards that the schema and the hand-written interfaces stay in sync. Purely
 * type-level and local, so nothing is emitted and no zod type reaches the declarations. Changing
 * one side without the other fails the build here.
 */
type Assert<T extends true> = T;

/**
 * Fails the build if the zod schema and the hand-written interfaces drift apart — add a field to
 * one and this stops compiling. Deliberately not exported: an exported alias would reference `z.*`
 * and put `import { z } from 'zod'` back into the emitted .d.ts, which is the exact thing the
 * interfaces above exist to prevent. The `{@link}` in the block comment on those interfaces is
 * what keeps `noUnusedLocals` from flagging it.
 */
type _ConfigTypesMatchSchema = [
  Assert<z.output<typeof evalConfigSchema> extends EvalConfig ? true : false>,
  Assert<EvalConfigInput extends z.input<typeof evalConfigSchema> ? true : false>,
];

/**
 * Identity helper giving editors full type-checking and completion in `mcpeval.config.js`:
 * `export default defineConfig({ ... })`.
 */
export function defineConfig(config: EvalConfigInput): EvalConfigInput {
  return config;
}

/** Parses and validates a raw config object, applying defaults. */
export function parseConfig(raw: unknown): EvalConfig {
  const parsed = evalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Parses a standalone scenarios file (an array of scenarios, or `{ scenarios: [...] }`). */
export function parseScenarios(raw: unknown): EvalScenario[] {
  const candidate =
    Array.isArray(raw) || raw === undefined
      ? raw
      : (raw as { scenarios?: unknown; default?: unknown }).scenarios ??
        (raw as { default?: unknown }).default;

  const parsed = z.array(scenarioSchema).safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Invalid scenarios file:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Fills in every optional scenario field so the runner and scorers never re-derive defaults:
 * `toolUnderTest` falls back to the first expected call, and `successCriteria` to
 * `tool-called-with` when any expected call constrains params (otherwise `tool-called`).
 */
export function resolveScenario(scenario: EvalScenario, defaultMaxTurns: number): ResolvedScenario {
  return {
    ...scenario,
    toolUnderTest: scenario.toolUnderTest ?? scenario.expectedToolCalls[0]?.toolName ?? scenario.id,
    successCriteria: scenario.successCriteria ?? defaultSuccessCriteria(scenario),
    maxTurns: scenario.maxTurns ?? defaultMaxTurns,
  };
}

function defaultSuccessCriteria(scenario: EvalScenario): SuccessCriteriaType {
  if (scenario.expectedToolCalls.length === 0) return 'no-error';
  return scenario.expectedToolCalls.some((call) => call.requiredParams !== undefined)
    ? 'tool-called-with'
    : 'tool-called';
}

/** Normalizes a `provider:modelId` string (or an already-explicit spec) into a {@link ModelSpec}. */
export function toModelSpec(ref: string | ModelSpec): ModelSpec {
  if (typeof ref !== 'string') return ref;

  const separatorIndex = ref.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`Invalid model "${ref}". Expected "provider:modelId".`);
  }

  const parsed = modelSpecSchema.safeParse({
    provider: ref.slice(0, separatorIndex),
    modelId: ref.slice(separatorIndex + 1),
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid model "${ref}": ${parsed.error.issues.map((issue) => issue.message).join('; ')}. ` +
        `Supported providers: ${PROVIDER_NAMES.join(', ')}.`
    );
  }
  return parsed.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

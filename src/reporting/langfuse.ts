import type { LangfuseReporterConfig, ReportersConfig } from '../config/config.js';
import type { EvalScore, ScenarioResult } from '../types.js';
import { modelLabel } from '../types.js';
import { importOptional } from '../providers/optional-dependency.js';

/**
 * Langfuse reporter — the "keep the history" sink. Each `(model × scenario)` run becomes one trace
 * named after the scenario, with the model in trace metadata and tags so dashboards can segment
 * "which model finds tool-calling easy vs hard". Per-tool child observations record the actual
 * arguments and results; deterministic + judge {@link EvalScore scores} are attached to the trace.
 *
 * Langfuse and OpenTelemetry are optional peer dependencies, imported only when this reporter runs.
 */

const LANGFUSE_PACKAGES = [
  '@langfuse/otel',
  '@langfuse/tracing',
  '@langfuse/client',
  '@opentelemetry/sdk-node',
  '@opentelemetry/api',
] as const;

const INSTALL_HINT = `npm install ${LANGFUSE_PACKAGES.join(' ')}`;

/** Langfuse OTel span attribute keys — set directly so no Langfuse types leak into the harness. */
const TRACE_SESSION_ID = 'session.id';
const TRACE_TAGS = 'langfuse.trace.tags';
const TRACE_METADATA_PREFIX = 'langfuse.trace.metadata.';

/**
 * Resolves the effective Langfuse settings, or `null` when the reporter should not run: disabled,
 * missing credentials, or `onlyOnCi` outside CI. Credentials fall back to the standard
 * `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASEURL` environment variables.
 */
export function resolveLangfuseConfig(reporters: ReportersConfig): LangfuseReporterConfig | null {
  const raw = reporters.langfuse;
  if (raw === undefined || raw === false) return null;

  const config: LangfuseReporterConfig =
    raw === true ? { enabled: true, onlyOnCi: false } : { ...raw };
  if (!config.enabled) return null;

  const publicKey = config.publicKey ?? process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = config.secretKey ?? process.env['LANGFUSE_SECRET_KEY'];
  if (!publicKey || !secretKey) {
    console.warn(
      'Langfuse reporting is enabled but LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set — skipping.'
    );
    return null;
  }
  if (config.onlyOnCi && !isCI()) return null;

  return {
    ...config,
    publicKey,
    secretKey,
    baseUrl: config.baseUrl ?? process.env['LANGFUSE_BASEURL'] ?? process.env['LANGFUSE_BASE_URL'],
  };
}

/** Exports every result to Langfuse as a trace with child tool observations and attached scores. */
export async function reportToLangfuse(
  results: ScenarioResult[],
  config: LangfuseReporterConfig
): Promise<void> {
  const langfuseModules = await loadLangfuse();
  const credentials = {
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };

  const spanProcessor = new langfuseModules.otel.LangfuseSpanProcessor(credentials);
  const sdk = new langfuseModules.sdkNode.NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  const client = new langfuseModules.client.LangfuseClient(credentials);

  try {
    for (const result of results) {
      await recordResult(result, client, langfuseModules);
    }
  } finally {
    // Always shut the SDK down, even if the score flush rejects, so telemetry resources close.
    try {
      await client.score.flush();
    } finally {
      await sdk.shutdown();
    }
  }
  console.log(`Exported ${results.length} eval traces to Langfuse.`);
}

async function recordResult(
  result: ScenarioResult,
  client: LangfuseClientLike,
  modules: LangfuseModules
): Promise<void> {
  return modules.tracing.startActiveObservation(
    result.scenario.id,
    async (root: ObservationLike) => {
      root.update({
        input: promptText(result),
        output: result.run.finalText,
        metadata: {
          total_turns: result.run.turns,
          reached_max_turns: result.run.reachedMaxTurns,
          duration_ms: result.run.durationMs,
        },
        ...(result.run.error ? { level: 'ERROR' as const } : {}),
      });

      applyTraceAttributes(result, modules);

      for (const call of result.run.toolCalls) {
        await modules.tracing.startActiveObservation(
          call.toolName,
          (observation: ObservationLike) => {
            observation.update({
              input: call.args,
              output: call.result,
              ...(call.isError ? { level: 'ERROR' as const } : {}),
            });
          },
          { asType: 'tool' }
        );
      }

      for (const score of result.scores) {
        client.score.activeTrace({
          name: score.name,
          value: score.value,
          dataType: score.dataType,
          ...(score.comment ? { comment: score.comment } : {}),
        });
      }
    },
    { asType: 'span' }
  );
}

/**
 * Sets trace-level session/tags/metadata on the active span. Written as raw OTel attributes because
 * the tracing SDK exposes no typed trace-update helper.
 */
function applyTraceAttributes(result: ScenarioResult, modules: LangfuseModules): void {
  const span = modules.api.trace.getActiveSpan();
  if (!span) return;

  const metadata: Record<string, string> = {
    model: result.model.modelId,
    provider: result.model.provider,
    scenario_id: result.scenario.id,
    tool_under_test: result.scenario.toolUnderTest,
    passed: String(result.passed),
    ...(result.scenario.difficulty ? { difficulty: result.scenario.difficulty } : {}),
  };

  // Group all of a model's scenario traces under one Langfuse session for side-by-side browsing.
  span.setAttribute(TRACE_SESSION_ID, modelLabel(result.model));
  span.setAttribute(TRACE_TAGS, [
    'mcp-evaluator',
    result.model.provider,
    result.model.modelId,
    ...(result.scenario.tags ?? []),
  ]);
  for (const [key, value] of Object.entries(metadata)) {
    span.setAttribute(`${TRACE_METADATA_PREFIX}${key}`, value);
  }
}

function promptText(result: ScenarioResult): string {
  return result.scenario.messages.map((message) => message.content).join('\n');
}

function isCI(): boolean {
  // Strict check: a literal "false"/"0"/empty value must not count as CI (Boolean() would).
  const ci = process.env['CI'];
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

async function loadLangfuse(): Promise<LangfuseModules> {
  const [otel, tracing, client, sdkNode, api] = await Promise.all(
    LANGFUSE_PACKAGES.map((name) => importOptional<unknown>(name, 'the langfuse reporter', INSTALL_HINT))
  );

  return {
    otel: otel as LangfuseModules['otel'],
    tracing: tracing as LangfuseModules['tracing'],
    client: client as LangfuseModules['client'],
    sdkNode: sdkNode as LangfuseModules['sdkNode'],
    api: api as LangfuseModules['api'],
  };
}

/**
 * Structural types for the optional Langfuse/OTel packages. Declared locally so the harness builds
 * and type-checks without them installed.
 */
interface ObservationLike {
  update(attributes: Record<string, unknown>): unknown;
}

interface LangfuseClientLike {
  score: {
    activeTrace(score: {
      name: string;
      value: number;
      dataType: string;
      comment?: string;
    }): unknown;
    flush(): Promise<unknown>;
  };
}

interface SpanLike {
  setAttribute(key: string, value: string | string[]): unknown;
}

interface LangfuseModules {
  otel: { LangfuseSpanProcessor: new (options: Record<string, unknown>) => unknown };
  tracing: {
    startActiveObservation<T>(
      name: string,
      callback: (observation: ObservationLike) => T,
      options?: { asType?: string }
    ): Promise<Awaited<T>>;
  };
  client: { LangfuseClient: new (options: Record<string, unknown>) => LangfuseClientLike };
  sdkNode: {
    NodeSDK: new (options: Record<string, unknown>) => { start(): void; shutdown(): Promise<void> };
  };
  api: { trace: { getActiveSpan(): SpanLike | undefined } };
}

# mcp-evaluator

A model-agnostic harness that measures **how well different LLMs call the tools of your MCP server**.

Each scenario poses a natural-language prompt to a real model, lets it drive an agentic loop against
your running MCP server, and grades the run: did it pick the right tool, build valid arguments,
succeed, invent a tool that doesn't exist, and how many turns did it take. Results print as a
leaderboard and can be written to Markdown/JSON or exported to Langfuse.

> **Why a harness rather than production traffic?** The model lives client-side and is usually never
> disclosed to the server. Only a harness that *chooses* the model can reliably attribute
> tool-calling behaviour to a specific model — and that attribution is the whole point.

```
$ npx mcp-evaluator --json results.json

=== Model leaderboard ===
┌────────────────────────────┬───────────┬────────┬───────────┬───────────┬────────────────┬──────────────┐
│ model                      │ scenarios │ passed │ pass_rate │ avg_turns │ avg_latency_ms │ total_tokens │
├────────────────────────────┼───────────┼────────┼───────────┼───────────┼────────────────┼──────────────┤
│ anthropic:claude-sonnet-5  │ 4         │ 4      │ 100%      │ 2.0       │ 1840           │ 12043        │
│ openai:gpt-4.1-mini        │ 4         │ 3      │ 75%       │ 2.5       │ 1210           │ 11890        │
│ gemini:gemini-2.5-flash    │ 4         │ 3      │ 75%       │ 2.8       │ 980            │ 13277        │
└────────────────────────────┴───────────┴────────┴───────────┴───────────┴────────────────┴──────────────┘
```

## Install

```sh
npm install --save-dev mcp-evaluator
```

That installs exactly one package — mcp-evaluator has **no runtime dependencies**.

Provider SDKs are **optional peer dependencies** — install only the ones you evaluate with:

| Provider    | Install                        | Credentials                                             |
| ----------- | ------------------------------ | ------------------------------------------------------- |
| `anthropic` | `npm i @anthropic-ai/sdk`      | `ANTHROPIC_API_KEY`                                      |
| `openai`    | `npm i openai`                 | `OPENAI_API_KEY` (`OPENAI_BASE_URL` for compatible APIs) |
| `gemini`    | `npm i @google/genai`          | `GEMINI_API_KEY`, or Vertex AI (see below)               |
| `ollama`    | — (plain HTTP)                 | none (`OLLAMA_BASE_URL`, default `http://localhost:11434`) |

The `openai` provider works against any OpenAI-compatible endpoint via `OPENAI_BASE_URL`, which
covers Azure OpenAI, OpenRouter, vLLM, LM Studio and friends without a dedicated adapter.

The `gemini` provider picks its backend from the environment: **Vertex AI** when
`GOOGLE_CLOUD_PROJECT` is set (or `GOOGLE_GENAI_USE_VERTEXAI=true`), using application-default
credentials and `GOOGLE_CLOUD_LOCATION` (default `us-central1`); otherwise the **Gemini Developer
API** with `GEMINI_API_KEY` / `GOOGLE_API_KEY`.

## Quick start

```sh
npx mcp-evaluator init      # writes a .mcpevalrc
npx mcp-evaluator --list    # show the run plan without spending a token
npx mcp-evaluator           # run it
```

`init` only creates names the CLI auto-discovers, and picks its syntax from the one you choose:

| Name | Format |
| --- | --- |
| `.mcpevalrc` | JSON (the default; extensionless, like `.babelrc`) |
| `mcpeval.config.json` | JSON |
| `mcpeval.config.mjs` | ESM, with commented explanations of every field |
| `mcpeval.config.cjs` | CommonJS |
| `mcpeval.config.{ts,mts}` | TypeScript (needs bun, tsx, or Node with type stripping) |
| `mcpeval.config.js` | ESM or CommonJS, following your `package.json` `type` |

Only JSON configs get `${ENV_VAR}` / `${ENV_VAR:-fallback}` interpolation — the JS-family formats
can read `process.env` directly. To keep a config under some other name, write it yourself and pass
`--config <path>`.

A minimal config — the MCP endpoint, the models, and what a correct answer looks like:

```js
// mcpeval.config.mjs
export default {
  server: {
    url: 'http://localhost:3000/mcp',
    headers: { authorization: `Bearer ${process.env.MCP_TOKEN}` },
  },
  models: ['anthropic:claude-sonnet-5', 'openai:gpt-4.1-mini'],
  scenarios: [
    {
      id: 'search.keyword',
      messages: [{ role: 'user', content: 'Search for documents about "cotton shirts".' }],
      toolsToEnable: ['search'],
      expectedToolCalls: [{ toolName: 'search' }],
      tags: ['search'],
    },
    {
      id: 'read.by-id',
      messages: [{ role: 'user', content: 'Get the document with ID "abc-123".' }],
      expectedToolCalls: [{ toolName: 'get_document', requiredParams: { id: 'abc-123' } }],
      tags: ['read'],
    },
  ],
};
```

Config may be `.mjs`, `.js`, `.cjs`, `.json` or `.ts` (TypeScript needs a TS-capable runtime such as
`bun` or `tsx`). JSON configs support `${ENV_VAR}` and `${ENV_VAR:-fallback}` interpolation, so
secrets stay out of the file. See [`examples/`](./examples) for fuller versions.

## How it works

```
cli.ts / runEvals()
  for each model (provider:modelId):
    for each scenario:
      mcp/mcp-client.ts        ── MCP initialize + tools/list over Streamable HTTP
      mcp/agentic-loop.ts      ── model ⇄ tool calls until it stops or maxTurns
      scoring/deterministic.ts ── tool choice, args, success, hallucination, turns
      scoring/llm-judge.ts     ── optional 0–1 judge scores
  reporting/  console · markdown · json · langfuse
```

The client speaks plain JSON-RPC over HTTP (JSON or SSE responses), so it works against any
HTTP-reachable MCP server. Server-specific needs are configuration, not code: auth and tenancy go in
`server.headers`, and gateways that gate tools server-side get `server.requestMeta` /
`server.sendEnabledToolsMeta`. A scenario's `toolsToEnable` is enforced client-side, so tool gating
works the same everywhere.

## Writing scenarios

A scenario is a prompt plus the ground truth used to grade it.

| Field               | Purpose                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `id`                | Stable reporting key                                                               |
| `messages`          | The user turn(s) that seed the loop                                                |
| `expectedToolCalls` | `{ toolName, requiredParams? }` — the calls a correct answer makes. Omit it for a scenario that should call nothing |
| `toolsToEnable`     | Restrict the tools the model sees. Omit to expose everything the server advertises |
| `successCriteria`   | `tool-called` · `tool-called-with` · `no-error` (inferred when omitted)            |
| `systemPrompt`      | Override the run-wide prompt for this scenario                                     |
| `maxTurns`          | Turn budget (default 5)                                                            |
| `difficulty`, `tags`, `description` | Reporting dimensions; `tags` also drive `--tag`                    |

`successCriteria` is inferred so you rarely set it: `tool-called-with` when any expected call
constrains `requiredParams`, `tool-called` when calls are expected but unconstrained, and `no-error`
when none are — which is how you test that a model *doesn't* reach for a tool it shouldn't.

Two knobs shape what a scenario actually measures. Narrowing `toolsToEnable` to a single tool tests
argument construction; exposing several similar tools tests discrimination. Phrasing the prompt as a
direct instruction tests instruction-following; phrasing it indirectly tests intent inference.

## Scores

Six deterministic scores, always computed:

| Score | Meaning |
| --- | --- |
| `correct_tool_selected` | 0/1 — at least one expected tool was called |
| `args_valid` | 0/1 — every `requiredParams` constraint was satisfied |
| `call_succeeded` | 0/1 — an expected tool was called *and* did not error |
| `hallucinated_tool` | 0/1 — the model invented a tool the server never advertised |
| `total_turns` | how many model turns the run took (fewer = easier) |
| `passed` | 0/1 — the scenario's `successCriteria` was met |

## LLM-as-a-judge

Deterministic scores can only see tool *names and arguments*. They cannot tell you whether the
chosen tool was the **most appropriate** of several valid ones, or whether the final answer was any
good. A judge model rates those two things 0–1.

```sh
mcp-evaluator --judge                                   # judge = the first model in your list
mcp-evaluator --judge-model anthropic:claude-sonnet-5   # a separate, stronger judge
```

```js
judge: { enabled: true, model: 'anthropic:claude-sonnet-5' }
```

It adds two scores:

| Score | Question the judge is asked |
| --- | --- |
| `tool_appropriateness` | Did the agent choose suitable tools for the request? |
| `answer_satisfies_intent` | Does the final answer address the user's request? |

The judge sees only the user request, the tool calls with their arguments and error flags, and the
final answer — never the expected tool calls, so it cannot simply parrot your ground truth. Its
`reasoning` string is attached as the `comment` on `tool_appropriateness`, and shows up in the JSON
report and Langfuse.

### Why it earns its keep

A real run against a reference server, where the deterministic scores and the judge disagree:

```
scenario                    passed  correct_tool_selected  tool_appropriateness  answer_satisfies_intent
discriminate.tool-choice    1       1                      1                     0
```

The model picked the right tool out of thirteen, so every deterministic score is green — but its
final answer was *"Please provide a request, and I will do my best to assist you!"*. The judge
caught what tool-name matching structurally cannot.

### Practical notes

- **It costs one extra model call per scenario**, which is why it is off by default.
- **Prefer a separate judge model.** A model grading its own transcript is not a neutral referee;
  the default (first model in the list) is a convenience, not a recommendation.
- **A judge failure never fails the run.** Unparseable output, a rate limit, a thrown error — the
  judge scores are dropped and the deterministic verdict stands alone.
- **Errored scenarios skip the judge**, so an unreachable server does not cost you grading calls.
- Prose and ```` ```json ```` fences around the verdict are tolerated.

Call it directly if you want judge scores outside a full run:

```js
import { runEvals, loadConfigFile, judgeRun, createProvider } from 'mcp-evaluator';

const config = await loadConfigFile('.mcpevalrc');

// Every result carries the resolved scenario and the raw run it was graded from.
const { results } = await runEvals({ ...config, reporters: { console: false } });

// Judge afterwards — with a stronger model, or to re-grade without paying for the runs again.
const judge = await createProvider({ provider: 'anthropic', modelId: 'claude-sonnet-5' });

for (const result of results) {
  const scores = await judgeRun(result.scenario, result.run, judge);
  // [{ name: 'tool_appropriateness', value: 1, dataType: 'NUMERIC', comment: '…' }, …]
  result.scores.push(...scores);
}
```

## CLI

```
mcp-evaluator [options] [provider:modelId ...]
mcp-evaluator init [path]

  -c, --config <path>       Config file (auto-discovered when omitted)
  -u, --url <url>           MCP server endpoint (overrides the config)
  -H, --header <name: val>  Extra request header; repeatable
  -s, --scenarios <path>    Load scenarios from a separate file
  -m, --model <spec>        Model to evaluate; repeatable
      --scenario <id>       Only run these scenario ids; repeatable
      --tag <tag>           Only run scenarios with one of these tags; repeatable
      --judge               Add the LLM-as-a-judge scores
      --judge-model <spec>  Model to judge with (implies --judge)
      --max-turns <n>       Default agentic-loop turn budget
      --markdown <path>     Write a Markdown summary
      --json <path>         Write the full results as JSON
      --langfuse            Export traces and scores to Langfuse
      --fail-under <pct>    Exit 1 when the pass rate is below this percentage
      --list                Print the run plan and exit
  -q, --quiet               Suppress the console tables
```

Positional arguments and `--model` override the config's model list:

```sh
mcp-evaluator anthropic:claude-sonnet-5 ollama:llama3.1:8b
mcp-evaluator --tag read --judge
mcp-evaluator --url http://localhost:3000/mcp --json results.json --fail-under 80
```

## Programmatic use

```js
import { runEvals } from 'mcp-evaluator';

const { results, passed, total, passRate } = await runEvals({
  server: { url: 'http://localhost:3000/mcp' },
  models: ['anthropic:claude-sonnet-5'],
  scenarios: [
    {
      id: 'search.keyword',
      messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
      expectedToolCalls: [{ toolName: 'search' }],
    },
  ],
  reporters: { console: false },
});
```

`results` is a `ScenarioResult[]` carrying, per `model × scenario`: every tool call with its
arguments and result, all scores, the model's final answer, token counts, duration, and any error.
That is enough to build any report you like. See [`examples/programmatic.mjs`](./examples/programmatic.mjs).

---

# Advanced usage

## Custom initialize metadata and gateway headers

Everything server-specific is configuration, not code. The handshake is fully controllable:

```js
server: {
  url: 'https://gateway.internal/projects/acme/mcp',

  // Sent on every request — auth, tenancy, tracing.
  headers: {
    authorization: `Bearer ${process.env.MCP_TOKEN}`,
    'x-tenant-id': 'acme',
  },

  // Who the harness claims to be in the `initialize` handshake.
  clientInfo: { name: 'acme-eval-suite', version: '2.1.0' },

  // Protocol version advertised during `initialize`.
  protocolVersion: '2025-06-18',

  // Merged into `params._meta` of EVERY request, `initialize` included.
  requestMeta: { tenant: 'acme', environment: 'staging' },

  // Additionally send the scenario's `toolsToEnable` as `_meta.tools`.
  sendEnabledToolsMeta: true,

  timeoutMs: 30_000,
}
```

That config produces this on the wire:

```jsonc
// → POST https://gateway.internal/projects/acme/mcp
// headers: authorization, x-tenant-id, mcp-session-id, mcp-protocol-version, x-session-id
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "acme-eval-suite", "version": "2.1.0" },
    "_meta": { "tenant": "acme", "environment": "staging", "tools": ["search"] }
  }
}
```

`_meta` is omitted entirely when `requestMeta` is empty and `sendEnabledToolsMeta` is off, so plain
MCP servers see a spec-clean request. Note that `toolsToEnable` is **always** enforced client-side
by filtering `tools/list`; `sendEnabledToolsMeta` is only for gateways that additionally gate
server-side.

The client handles session ids (`mcp-session-id`), the post-handshake
`notifications/initialized`, and both `application/json` and `text/event-stream` responses.

## Typed configs

`defineConfig` is an identity function that gives editors full completion and checking:

```ts
// mcpeval.config.ts
import { defineConfig } from 'mcp-evaluator';

export default defineConfig({
  server: { url: process.env.MCP_URL ?? 'http://localhost:3000/mcp' },
  models: [
    'anthropic:claude-sonnet-5',
    { provider: 'ollama', modelId: 'llama3.1:8b', label: 'local-baseline' },
  ],
  scenarios: [],
});
```

In a `.js` config, the JSDoc form does the same with no import:

```js
/** @type {import('mcp-evaluator').EvalConfigInput} */
export default { server: { url: 'http://localhost:3000/mcp' } };
```

`label` on a `ModelSpec` overrides the `provider:modelId` string used in every report — handy when
you are comparing two configurations of the same model.

## Extending the types

The input and output shapes are separate types. Author against `*Input`; consume `EvalConfig`,
which has every default filled in.

| Authoring | After validation |
| --- | --- |
| `EvalConfigInput` | `EvalConfig` |
| `McpServerConfigInput` | `McpServerConfig` |
| `ReportersConfigInput` | `ReportersConfig` |
| `JudgeConfigInput` | `JudgeConfig` |
| `EvalScenarioInput` (`expectedToolCalls` optional) | `EvalScenario` → `ResolvedScenario` |

Build suites with factories rather than by hand:

```ts
import type { EvalScenarioInput, ExpectedToolCall } from 'mcp-evaluator';

/** One scenario per id, all exercising the same by-id read tool. */
function readById(tool: string, ids: string[]): EvalScenarioInput[] {
  return ids.map((id) => {
    const expectedToolCalls: ExpectedToolCall[] = [{ toolName: tool, requiredParams: { id } }];
    return {
      id: `read.${id}`,
      messages: [{ role: 'user', content: `Fetch the document with ID "${id}".` }],
      toolsToEnable: [tool],
      expectedToolCalls,
      difficulty: 'easy',
      tags: ['read', 'generated'],
    };
  });
}

export default { server: { url: '…' }, scenarios: readById('get_document', ['a-1', 'b-2']) };
```

Need extra fields of your own? Extend the type and strip them before handing the suite over —
unknown keys are rejected by validation:

```ts
import type { EvalScenarioInput } from 'mcp-evaluator';

interface OwnedScenario extends EvalScenarioInput {
  owner: string;
  ticket: string;
}

const owned: OwnedScenario[] = [/* … */];
const scenarios: EvalScenarioInput[] = owned.map(({ owner, ticket, ...scenario }) => scenario);
```

## Generating scenarios from the live tool list

`MCPEvalClient` is exported, so you can ask the server what it exposes and build a smoke suite
that never goes stale:

```js
import { MCPEvalClient, parseConfig, runEvals } from 'mcp-evaluator';

const { server } = parseConfig({ server: { url: 'http://localhost:3000/mcp' } });
const client = new MCPEvalClient(server);
await client.connect();
const tools = await client.listTools();
await client.disconnect();

await runEvals({
  server,
  models: ['anthropic:claude-sonnet-5'],
  // One scenario per advertised tool: can the model call it at all, given only its description?
  scenarios: tools.map((tool) => ({
    id: `smoke.${tool.name}`,
    messages: [{ role: 'user', content: `${tool.description} Do that now.` }],
    toolsToEnable: [tool.name],
    expectedToolCalls: [{ toolName: tool.name }],
    tags: ['smoke'],
  })),
});
```

## A custom model provider

`runEvals` resolves providers from the four built-in names, so it cannot take a custom instance.
To evaluate a backend it does not cover — an internal gateway, a bedrock wrapper, a recorded
fixture — implement `ModelProvider` and drive the loop yourself:

```ts
import {
  MCPEvalClient, parseConfig, resolveScenario, runAgenticLoop, scoreScenario,
} from 'mcp-evaluator';
import type {
  MCPToolDefinition, ModelProvider, ModelTurn, ProviderMessage,
} from 'mcp-evaluator';

class GatewayProvider implements ModelProvider {
  // Only used for report labelling; the loop calls generateWithTools and nothing else.
  readonly provider = 'openai' as const;
  constructor(readonly modelId: string) {}

  async generateWithTools(
    messages: ProviderMessage[],
    tools: MCPToolDefinition[],
    systemPrompt?: string
  ): Promise<ModelTurn> {
    const reply = await callYourBackend({ messages, tools, systemPrompt });
    return {
      textContent: reply.text,
      toolCalls: reply.calls,        // [{ id, name, input }]
      inputTokens: reply.usage.in,
      outputTokens: reply.usage.out,
      rawContent: reply.blocks,      // text / tool_use blocks, replayed as history next turn
    };
  }
}

const { server } = parseConfig({ server: { url: 'http://localhost:3000/mcp' } });
const scenario = resolveScenario(
  {
    id: 'search.basic',
    messages: [{ role: 'user', content: 'Find the reports.' }],
    expectedToolCalls: [{ toolName: 'search' }],
  },
  5 // default maxTurns
);

const client = new MCPEvalClient(server);
await client.connect(scenario.toolsToEnable);
const run = await runAgenticLoop(scenario, new GatewayProvider('my-model'), client);
await client.disconnect();

const { scores, passed } = scoreScenario(scenario, run);
```

`resolveScenario` fills the defaults the runner relies on — `expectedToolCalls`, `toolUnderTest`,
`successCriteria`, `maxTurns` — so pass hand-written scenarios through it before scoring.

Note the `provider` field must be one of `anthropic`, `openai`, `gemini`, `ollama`. It is a label
only; nothing dispatches on it inside the loop.

## Custom reporting

Turn the built-in reporters off and consume `results` directly:

```js
import { runEvals, loadConfigFile, buildJsonReport, buildLeaderboard, modelLabel } from 'mcp-evaluator';

// Reuse the config file you already have rather than repeating it in the script.
const config = await loadConfigFile('.mcpevalrc');

const { results } = await runEvals({ ...config, reporters: { console: false } });

// Which models invent tools that do not exist?
for (const result of results) {
  const invented = result.run.toolCalls.filter((call) => call.isHallucination);
  if (invented.length > 0) {
    console.log(`${modelLabel(result.model)} invented ${invented.map((c) => c.toolName).join(', ')}`);
  }
}

// Which tool is hardest, across every model?
const failuresByTool = new Map();
for (const result of results.filter((r) => !r.passed)) {
  const tool = result.scenario.toolUnderTest;
  failuresByTool.set(tool, (failuresByTool.get(tool) ?? 0) + 1);
}

// Or reuse the built-in aggregations without their output side effects.
const report = buildJsonReport(results);   // the same object the `json` reporter writes
const board = buildLeaderboard(results);   // per-model rows: pass_rate, avg_turns, tokens, latency
```

`renderMarkdownSummary(results)` returns the Markdown string without writing a file, and
`reportToConsole(results)` prints the tables on demand.

## Comparing prompts instead of models

Nothing says the variable has to be the model. Hold the model fixed and vary `systemPrompt` to
measure how much guidance your tool descriptions actually need:

```js
import { runEvals, loadConfigFile } from 'mcp-evaluator';

const config = await loadConfigFile('.mcpevalrc');

const prompts = {
  bare: undefined,                                   // tool descriptions alone
  nudged: 'Always use a tool when one is relevant.',
  strict: 'You MUST call exactly one tool before answering. Never guess.',
};

for (const [name, systemPrompt] of Object.entries(prompts)) {
  const { passRate } = await runEvals({ ...config, systemPrompt, reporters: { console: false } });
  console.log(`${name.padEnd(8)} ${(passRate * 100).toFixed(0)}%`);
}
```

## Splitting suites

Keep several scenario files and pick one per run:

```sh
mcp-evaluator --scenarios ./evals/smoke.mjs        # fast pre-merge gate
mcp-evaluator --scenarios ./evals/full.mjs --judge # nightly, with judge scores
mcp-evaluator --tag read --tag search              # or slice the configured suite by tag
mcp-evaluator --scenario read.by-id                # a single scenario while iterating
```

A scenarios file default-exports an array, or exports `{ scenarios: [...] }`:

```js
// evals/smoke.mjs
/** @type {import('mcp-evaluator').EvalScenarioInput[]} */
export default [
  { id: 'smoke.search', messages: [{ role: 'user', content: 'Search for "x".' }],
    expectedToolCalls: [{ toolName: 'search' }] },
];
```

## Langfuse export

Optional, and behind its own peer dependencies:

```sh
npm i @langfuse/otel @langfuse/tracing @langfuse/client @opentelemetry/sdk-node @opentelemetry/api
```

```js
reporters: { langfuse: { enabled: true, onlyOnCi: true } }
```

Credentials come from `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASEURL` unless set
in the config. Each `model × scenario` run becomes one trace, tagged and session-grouped by model,
with per-tool child observations and every score attached — so you can segment "which model finds
which tool hard" in a dashboard.

## In CI

```yaml
- run: npx mcp-evaluator --markdown eval-summary.md --json eval-results.json --fail-under 80
  env:
    MCP_URL: http://localhost:3000/mcp
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
- run: cat eval-summary.md >> $GITHUB_STEP_SUMMARY
  if: always()
```

`--fail-under` is the gate: the CLI exits 1 when the pass rate falls below the threshold. Scenarios
that throw (unreachable server, rate limit) are recorded as failed runs and listed under `Errors`
rather than aborting the run.

## Configuration reference

| Key                            | Default             | Purpose                                                     |
| ------------------------------ | ------------------- | ----------------------------------------------------------- |
| `server.url`                   | —                   | **Required.** MCP endpoint                                  |
| `server.headers`               | `{}`                | Sent on every request (auth, tenancy)                       |
| `server.protocolVersion`       | `2025-06-18`        | Version advertised during `initialize`                      |
| `server.clientInfo`            | `mcp-evaluator/1.0.0` | Client identity in the handshake                          |
| `server.requestMeta`           | `{}`                | Extra `_meta` merged into every request                     |
| `server.sendEnabledToolsMeta`  | `false`             | Also send `toolsToEnable` as `_meta.tools`                  |
| `server.timeoutMs`             | `60000`             | Per-request timeout                                         |
| `models`                       | `[]`                | `provider:modelId` strings or `{ provider, modelId, label }`|
| `scenarios`                    | `[]`                | The suite                                                   |
| `systemPrompt`                 | built-in generic    | Run-wide system prompt                                      |
| `maxTurns`                     | `5`                 | Default turn budget                                         |
| `judge.enabled`                | `false`             | Adds `tool_appropriateness` + `answer_satisfies_intent`     |
| `judge.model`                  | first evaluated model | Model used as the judge; a separate one is recommended    |
| `reporters.console`            | `true`              | Console tables                                              |
| `reporters.markdown`           | —                   | Path for the Markdown summary                               |
| `reporters.json`               | —                   | Path for the JSON report                                    |
| `reporters.langfuse`           | —                   | `true` or `{ enabled, publicKey, secretKey, baseUrl, onlyOnCi }` |
| `failUnder`                    | —                   | Exit 1 below this pass-rate percentage                      |

## Requirements

Node >= 20.11. The package ships both ESM and CommonJS builds, so `import` and `require` both
work, with TypeScript declarations for either.

## License

MIT

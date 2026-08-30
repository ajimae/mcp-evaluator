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
| `mcpeval.config.ts` / `.mts` | TypeScript (needs bun, tsx, or Node with type stripping) |
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
| `expectedToolCalls` | `{ toolName, requiredParams? }` — the calls a correct answer makes                 |
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

Always computed: `correct_tool_selected`, `args_valid`, `call_succeeded`, `hallucinated_tool`,
`total_turns`, `passed`.

With `--judge` (one extra model call per run): `tool_appropriateness` and `answer_satisfies_intent`,
each 0–1. The judge defaults to the first evaluated model; `--judge-model` picks another.

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

const { results, passRate } = await runEvals({
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

`runEvals` returns `{ results, passed, total, passRate }`. `results` carries every tool call,
argument, score and the model's final answer — enough to build your own report. The building blocks
(`MCPEvalClient`, `runAgenticLoop`, `scoreScenario`, `judgeRun`, `buildJsonReport`, the providers)
are exported too. See [`examples/programmatic.mjs`](./examples/programmatic.mjs).

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
| `judge.enabled` / `judge.model`| `false` / first model | LLM-as-a-judge scores                                     |
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

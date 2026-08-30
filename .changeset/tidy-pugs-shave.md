---
'mcp-evaluator': patch
---

Rewrite as a vendor-neutral, publishable package.

The harness now evaluates any HTTP-reachable MCP server: the endpoint, headers, models and
scenarios all come from an `mcpeval.config.*` / `.mcpevalrc` file or CLI flags, and no server,
tool vocabulary or scenario suite is baked in.

- Ships ESM and CommonJS builds with bundled type declarations, and **no runtime dependencies** —
  provider SDKs and the Langfuse exporter are optional peer dependencies loaded on first use.
- `mcp-evaluator init` scaffolds a config in the syntax its filename implies.
- Reporters for console, Markdown, JSON and Langfuse, plus `--fail-under` as a CI gate.
- Optional LLM-as-a-judge scoring, and a new `hallucinated_tool` deterministic score.

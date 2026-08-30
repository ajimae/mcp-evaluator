/**
 * Config scaffolds written by `mcp-evaluator init`.
 *
 * The loader accepts JSON, ESM, CommonJS and TypeScript configs, so `init` has to emit syntax that
 * matches the filename it was given — writing an ESM module into a `.json` file produces a config
 * that cannot be parsed. The JS-family formats share one body and differ only in their export.
 */

import { EXTENSIONLESS_JSON_CONFIGS } from '../config/load-config.js';

/** Config syntaxes `init` can emit. */
export type ConfigFormat = 'esm' | 'cjs' | 'ts' | 'json';

/** Extensions `init` recognises, in the order shown to the user on an unsupported one. */
export const SUPPORTED_CONFIG_EXTENSIONS = [
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.mts',
  '.json',
] as const;

/** The default filename when `init` is given no argument. */
export const DEFAULT_CONFIG_FILENAME = '.mcpevalrc';

/**
 * The shared config literal for every JS-family format. Deliberately free of template literals so
 * it can be embedded here without escaping, and so the emitted file has no nested-quoting traps.
 */
const BODY = `{
  // The MCP server under test. Any HTTP-reachable MCP endpoint works.
  server: {
    url: process.env.MCP_URL || 'http://localhost:3000/mcp',
    headers: {
      // Anything your server needs: bearer tokens, API keys, tenant ids, ...
      ...(process.env.MCP_TOKEN ? { authorization: 'Bearer ' + process.env.MCP_TOKEN } : {}),
    },
    // Uncomment for gateways that gate tools server-side rather than advertising them all:
    // sendEnabledToolsMeta: true,
    // requestMeta: { tenant: 'acme' },
  },

  // Models to evaluate, as provider:modelId. CLI arguments override this list.
  // Credentials come from the usual env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).
  models: ['anthropic:claude-sonnet-5'],

  // Optional: a run-wide system prompt. Leave it out to test the tool descriptions on their own.
  // systemPrompt: 'You are a helpful assistant.',

  // Scenarios: a prompt plus the tool calls a correct answer requires. Replace these with tools
  // your server actually exposes — 'mcp-evaluator --list' shows the plan without spending tokens.
  scenarios: [
    {
      id: 'search.basic',
      description: 'calls the search tool for a plain keyword query',
      difficulty: 'easy',
      messages: [{ role: 'user', content: 'Search for "quarterly report".' }],
      // Only expose these tools to the model; omit to expose everything the server advertises.
      toolsToEnable: ['search'],
      expectedToolCalls: [{ toolName: 'search' }],
      tags: ['search'],
    },
    {
      id: 'search.with-args',
      description: 'passes the identifier through as an argument',
      difficulty: 'medium',
      messages: [{ role: 'user', content: 'Fetch the document with id "doc-123".' }],
      expectedToolCalls: [{ toolName: 'get_document', requiredParams: { id: 'doc-123' } }],
      // requiredParams present => graded as 'tool-called-with' unless you say otherwise.
      tags: ['read'],
    },
  ],

  // Optional LLM-as-a-judge scores (one extra model call per run).
  judge: { enabled: false },

  reporters: {
    console: true,
    // markdown: 'eval-summary.md',
    // json: 'eval-results.json',
    // langfuse: true,
  },
}`;

/**
 * JSON cannot carry comments, so this variant is self-describing through its values instead. It
 * also shows the `\${VAR:-fallback}` interpolation the JSON loader applies, which is how secrets
 * stay out of a checked-in config.
 */
const JSON_TEMPLATE = `{
  "server": {
    "url": "\${MCP_URL:-http://localhost:3000/mcp}",
    "headers": {
      "authorization": "Bearer \${MCP_TOKEN:-replace-me}"
    }
  },
  "models": ["anthropic:claude-sonnet-5"],
  "scenarios": [
    {
      "id": "search.basic",
      "description": "calls the search tool for a plain keyword query",
      "difficulty": "easy",
      "messages": [{ "role": "user", "content": "Search for \\"quarterly report\\"." }],
      "toolsToEnable": ["search"],
      "expectedToolCalls": [{ "toolName": "search" }],
      "tags": ["search"]
    },
    {
      "id": "search.with-args",
      "description": "passes the identifier through as an argument",
      "difficulty": "medium",
      "messages": [{ "role": "user", "content": "Fetch the document with id \\"doc-123\\"." }],
      "expectedToolCalls": [
        { "toolName": "get_document", "requiredParams": { "id": "doc-123" } }
      ],
      "tags": ["read"]
    }
  ],
  "judge": { "enabled": false },
  "reporters": { "console": true }
}
`;

/** Renders the scaffold for `format`. */
export function renderConfigTemplate(format: ConfigFormat): string {
  switch (format) {
    case 'json':
      return JSON_TEMPLATE;
    case 'cjs':
      return `/** @type {import('mcp-evaluator').EvalConfigInput} */\nmodule.exports = ${BODY};\n`;
    case 'ts':
      return (
        "import type { EvalConfigInput } from 'mcp-evaluator';\n\n" +
        '// TypeScript configs need a TS-capable runtime (bun, tsx, or Node >=22.6 with\n' +
        '// --experimental-strip-types). Use .mjs or .json to run under plain Node.\n' +
        `const config: EvalConfigInput = ${BODY};\n\nexport default config;\n`
      );
    case 'esm':
      return `// @ts-check\n/** @type {import('mcp-evaluator').EvalConfigInput} */\nexport default ${BODY};\n`;
  }
}

/**
 * Picks the format for a target filename.
 *
 * `.js` is ambiguous — Node reads it as ESM or CommonJS depending on the nearest package.json
 * `type` — so the caller passes what it found there and we emit matching syntax.
 *
 * @returns The format, or `null` when the name is not one we can scaffold.
 */
export function detectConfigFormat(
  filePath: string,
  packageType?: string | undefined
): ConfigFormat | null {
  // `.mcpevalrc` carries no extension but is JSON, so it has to be matched by name.
  if (EXTENSIONLESS_JSON_CONFIGS.includes(basenameOf(filePath))) return 'json';

  switch (extensionOf(filePath)) {
    case '.json':
      return 'json';
    case '.mjs':
      return 'esm';
    case '.ts':
    case '.mts':
      return 'ts';
    case '.cjs':
      return 'cjs';
    case '.js':
      return packageType === 'module' ? 'esm' : 'cjs';
    default:
      return null;
  }
}

function basenameOf(filePath: string): string {
  return filePath.replace(/^.*[\\/]/, '');
}

/** Lowercased final extension, e.g. `.json` for `mcpeval.config.json`, `''` for `.mcpevalrc`. */
function extensionOf(filePath: string): string {
  const base = basenameOf(filePath);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

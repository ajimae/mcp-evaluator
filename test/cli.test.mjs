import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { startMockMcpServer } from './helpers/mock-mcp-server.mjs';
import { startMockOllama, toolCall } from './helpers/mock-ollama.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url));

const TOOLS = [
  { name: 'search', description: 'search things', inputSchema: { type: 'object' } },
  { name: 'get_document', description: 'fetch a document', inputSchema: { type: 'object' } },
];

/** Runs the CLI, returning its exit code alongside stdout/stderr instead of throwing on failure. */
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('cli', () => {
  let mcp;
  let ollama;
  let dir;

  before(async () => {
    mcp = await startMockMcpServer({ tools: TOOLS });
    ollama = await startMockOllama([toolCall('search', {}), { content: 'Found it.' }]);
    dir = mkdtempSync(join(tmpdir(), 'mcp-evaluator-cli-'));
  });

  after(async () => {
    await Promise.all([mcp.close(), ollama.close()]);
  });

  it('scaffolds a config and refuses to clobber an existing one', async () => {
    const first = await cli(['init'], { cwd: dir });
    assert.equal(first.code, 0);
    assert.match(first.stdout, /Created/);

    const second = await cli(['init'], { cwd: dir });
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already exists/);
  });

  it('discovers the config in the working directory and prints the plan', async () => {
    const { code, stdout } = await cli(['--list'], { cwd: dir });

    assert.equal(code, 0);
    assert.match(stdout, /Using config .*mcpevalrc/);
    assert.match(stdout, /Total runs: 2/);
  });

  it('interpolates env vars in a JSON config and honours CLI overrides', async () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        server: { url: 'http://placeholder.invalid/mcp', headers: { authorization: '${MCP_TOKEN}' } },
        models: ['ollama:placeholder'],
        scenarios: [
          {
            id: 'search.basic',
            messages: [{ role: 'user', content: 'Search for "reports".' }],
            expectedToolCalls: [{ toolName: 'search' }],
            tags: ['search'],
          },
          {
            id: 'read.by-id',
            messages: [{ role: 'user', content: 'Fetch doc-123.' }],
            expectedToolCalls: [{ toolName: 'get_document' }],
            tags: ['read'],
          },
        ],
      })
    );

    const jsonPath = join(dir, 'results.json');
    const { code, stdout } = await cli(
      [
        '--config', configPath,
        '--url', mcp.url,
        '--model', 'ollama:test-model',
        '--tag', 'search',
        '--json', jsonPath,
        '--quiet',
      ],
      { cwd: dir, env: { ...process.env, MCP_TOKEN: 'Bearer tok', OLLAMA_BASE_URL: ollama.baseUrl } }
    );

    assert.equal(code, 0, stdout);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(report.results.length, 1, '--tag narrowed the suite to one scenario');
    assert.equal(report.results[0].scenario, 'search.basic');
    assert.equal(report.results[0].model, 'ollama:test-model', '--model overrode the config');
    assert.equal(
      mcp.received.headers.at(-1).authorization,
      'Bearer tok',
      'the ${MCP_TOKEN} placeholder reached the server'
    );
  });

  it('exits 1 when the pass rate is below --fail-under', async () => {
    const configPath = join(dir, 'failing.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        server: { url: mcp.url },
        models: ['ollama:test-model'],
        scenarios: [
          {
            id: 'expects.other.tool',
            messages: [{ role: 'user', content: 'Do something else.' }],
            expectedToolCalls: [{ toolName: 'get_document' }],
          },
        ],
      })
    );

    const { code, stderr } = await cli(
      ['--config', configPath, '--fail-under', '100', '--quiet'],
      { cwd: dir, env: { ...process.env, OLLAMA_BASE_URL: ollama.baseUrl } }
    );

    assert.equal(code, 1);
    assert.match(stderr, /below the --fail-under threshold/);
  });

  it('reports a missing config without a stack trace', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mcp-evaluator-empty-'));
    const { code, stderr } = await cli([], { cwd: empty });

    assert.equal(code, 1);
    assert.match(stderr, /No config file found/);
    assert.doesNotMatch(stderr, /at .*\(/, 'no stack trace is printed');
  });

  it('rejects a malformed --header', async () => {
    const { code, stderr } = await cli(['--header', 'nocolon', '--list'], { cwd: dir });

    assert.equal(code, 1);
    assert.match(stderr, /Invalid --header/);
  });
});

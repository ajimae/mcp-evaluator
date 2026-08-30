import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../dist/index.mjs';

/**
 * `init` has to emit syntax matching the filename it is given, and may only create names the
 * loader can discover. These tests assert the round trip: scaffold a config, then load it back
 * through the real loader — a template that merely *looks* right but does not parse is the bug
 * this guards.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url));

async function cli(args, options = {}) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], options);
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A scratch project. `packageType` controls how Node interprets a bare `.js` config. */
function project(packageType) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-evaluator-init-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(packageType ? { name: 't', type: packageType } : { name: 't' })
  );
  return dir;
}

describe('init', () => {
  const dirs = [];
  after(() => dirs.length = 0);

  /** Scaffolds `filename`, asserts the syntax, and loads it back through the real loader. */
  async function scaffoldAndLoad(filename, packageType) {
    const dir = project(packageType);
    dirs.push(dir);
    const { code, stdout } = await cli(['init', filename], { cwd: dir });
    assert.equal(code, 0, stdout);

    const path = join(dir, filename);
    const source = readFileSync(path, 'utf8');
    const config = await loadConfigFile(path);
    return { source, config, stdout };
  }

  it('defaults to .mcpevalrc when given no argument', async () => {
    const dir = project('module');
    dirs.push(dir);
    const { code, stdout } = await cli(['init'], { cwd: dir });

    assert.equal(code, 0);
    assert.match(stdout, /\(json\)/);
    const config = await loadConfigFile(join(dir, '.mcpevalrc'));
    assert.equal(config.scenarios.length, 2);
  });

  it('writes real JSON for a .json target', async () => {
    const { source, config } = await scaffoldAndLoad('mcpeval.config.json', 'module');

    // The bug: this used to be an ES module written into a .json file.
    assert.doesNotMatch(source, /export default|module\.exports/);
    assert.doesNotThrow(() => JSON.parse(source), 'the file must be valid JSON');
    assert.equal(config.server.url, 'http://localhost:3000/mcp', 'env interpolation applied');
    assert.equal(config.scenarios.length, 2);
  });

  it('writes ESM for .mjs and TypeScript for .ts/.mts', async () => {
    const esm = await scaffoldAndLoad('mcpeval.config.mjs', 'module');
    assert.match(esm.source, /^\/\/ @ts-check/);
    assert.match(esm.source, /export default \{/);

    for (const name of ['mcpeval.config.ts', 'mcpeval.config.mts']) {
      const dir = project('module');
      dirs.push(dir);
      assert.equal((await cli(['init', name], { cwd: dir })).code, 0);
      const source = readFileSync(join(dir, name), 'utf8');
      assert.match(source, /import type \{ EvalConfigInput \} from 'mcp-evaluator';/);
      assert.match(source, /const config: EvalConfigInput = \{/);
    }
  });

  it('writes CommonJS for .cjs', async () => {
    const { source, config } = await scaffoldAndLoad('mcpeval.config.cjs', 'module');

    assert.match(source, /module\.exports = \{/);
    assert.doesNotMatch(source, /export default/);
    assert.equal(config.models.length, 1);
  });

  it('resolves the ambiguous .js extension from the project package type', async () => {
    const esm = await scaffoldAndLoad('mcpeval.config.js', 'module');
    assert.match(esm.source, /export default \{/, 'type: module => ESM');

    const cjs = await scaffoldAndLoad('mcpeval.config.js', 'commonjs');
    assert.match(cjs.source, /module\.exports = \{/, 'type: commonjs => CommonJS');

    const none = await scaffoldAndLoad('mcpeval.config.js');
    assert.match(none.source, /module\.exports = \{/, 'no type field => CommonJS, as Node assumes');
  });

  it('refuses names the CLI would never discover', async () => {
    const dir = project('module');
    dirs.push(dir);

    // The extension is supported but the stem is not, so the file would need --config forever.
    const wrongStem = await cli(['init', 'conf.json'], { cwd: dir });
    assert.equal(wrongStem.code, 1);
    assert.match(wrongStem.stderr, /must use a name the CLI can discover/);
    assert.match(wrongStem.stderr, /Did you mean: {2}mcp-evaluator init mcpeval\.config\.json/);

    // Unsupported extension: same rejection, but there is no sensible suggestion to offer.
    const wrongExt = await cli(['init', 'config.yaml'], { cwd: dir });
    assert.equal(wrongExt.code, 1);
    assert.match(wrongExt.stderr, /must use a name the CLI can discover/);
    assert.doesNotMatch(wrongExt.stderr, /Did you mean/);

    const noExt = await cli(['init', 'myconfig'], { cwd: dir });
    assert.equal(noExt.code, 1);
    assert.doesNotMatch(noExt.stderr, /Did you mean/);
  });

  it('treats the extensionless rc file as JSON', async () => {
    const dir = project('module');
    dirs.push(dir);
    const { code, stdout } = await cli(['init', '.mcpevalrc'], { cwd: dir });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /\(json\)/);

    // `.mcpevalrc` has no extension, so it must be parsed as JSON rather than imported — Node
    // cannot infer a module loader for an extensionless file.
    const source = readFileSync(join(dir, '.mcpevalrc'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(source), '.mcpevalrc must be valid JSON');

    const config = await loadConfigFile(join(dir, '.mcpevalrc'));
    assert.equal(config.scenarios.length, 2);

    // And a bare run must find it.
    const listed = await cli(['--list'], { cwd: dir });
    assert.match(listed.stdout, /Using config .*\.mcpevalrc/);
  });

  it('no longer accepts the retired .mcpevalrc.json name', async () => {
    const dir = project('module');
    dirs.push(dir);
    const { code, stderr } = await cli(['init', '.mcpevalrc.json'], { cwd: dir });

    assert.equal(code, 1);
    assert.match(stderr, /must use a name the CLI can discover/);

    // The rejected name is echoed back on the first line, so only the list itself is checked.
    const validNames = stderr.split('\n').find((line) => line.startsWith('Valid names:'));
    assert.doesNotMatch(validNames, /\.mcpevalrc\.json/, 'must not be offered as a valid name');
    assert.match(validNames, /\.mcpevalrc\b/, 'the extensionless form is still offered');
  });

  it('accepts a valid name under a subdirectory', async () => {
    const dir = project('module');
    dirs.push(dir);

    // Only the basename is validated, so a config can live in a subdirectory.
    assert.equal((await cli(['init', 'nested/mcpeval.config.cjs'], { cwd: dir })).code, 1,
      'the subdirectory does not exist yet');
  });

  it('scaffolds a name that a bare run then auto-discovers', async () => {
    const dir = project('module');
    dirs.push(dir);
    assert.equal((await cli(['init', 'mcpeval.config.json'], { cwd: dir })).code, 0);

    const { code, stdout } = await cli(['--list'], { cwd: dir });
    assert.equal(code, 0);
    assert.match(stdout, /Using config .*mcpeval\.config\.json/);
  });

  it('still refuses to overwrite an existing file', async () => {
    const dir = project('module');
    dirs.push(dir);
    assert.equal((await cli(['init', 'mcpeval.config.json'], { cwd: dir })).code, 0);
    const second = await cli(['init', 'mcpeval.config.json'], { cwd: dir });

    assert.equal(second.code, 1);
    assert.match(second.stderr, /already exists/);
  });
});

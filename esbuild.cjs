const esbuild = require('esbuild');
const pkg = require('./package.json');

/**
 * Bundles the library (ESM + CJS) and the CLI. `tsc` emits declarations only, so this is the sole
 * producer of JavaScript — which is what lets the version be injected as a build-time constant.
 */

/**
 * The package ships with zero runtime dependencies: everything it statically imports (zod) is a
 * devDependency and gets inlined here, so `npm i mcp-evaluator` installs exactly one package.
 * Add a new runtime import and it will be bundled too — that is the intent, so keep it a
 * devDependency rather than adding a `dependencies` entry.
 *
 * The optional peers are listed for documentation and as insurance. They are already excluded in
 * practice: they load via `await import(variableSpecifier)` (see providers/optional-dependency.ts),
 * which esbuild cannot resolve statically, so it never inlines them regardless of this list. They
 * must resolve from the consumer's node_modules for the "install it with" hint to be meaningful.
 */
const external = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

// No shebang banner for the CLI: esbuild already carries over the one on src/cli.ts, and adding
// a second emits it twice, which is a syntax error.
const targets = [
  { in: 'cli.ts', out: 'cli.cjs', format: 'cjs' },
  { in: 'index.ts', out: 'index.cjs', format: 'cjs' },
  { in: 'index.ts', out: 'index.mjs', format: 'esm' },
];

function options(target) {
  return {
    entryPoints: [`src/${target.in}`],
    outfile: `dist/${target.out}`,
    format: target.format,
    bundle: true,
    // Unminified and map-free on purpose: minifying buys nothing for a package that is never
    // sent over the wire per-request, and without maps a minified stack trace is unreadable.
    // Leaving it readable also keeps dist/ at exactly five files.
    minify: false,
    sourcemap: false,
    platform: 'node',
    // Matches the `engines.node` floor in package.json.
    target: 'node20',
    external,
    define: {
      // Consumed by src/cli.ts; avoids an import.meta.url lookup that CJS cannot do.
      __MCP_EVALUATOR_VERSION__: JSON.stringify(pkg.version),
    },
  };
}

Promise.all(targets.map((target) => esbuild.build(options(target)))).catch((error) => {
  console.error(error);
  // Without this the process exits 0 and a broken build sails through CI.
  process.exitCode = 1;
});

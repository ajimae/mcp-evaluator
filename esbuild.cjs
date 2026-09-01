const esbuild = require('esbuild');
const pkg = require('./package.json');

const external = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

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
  process.exitCode = 1;
});

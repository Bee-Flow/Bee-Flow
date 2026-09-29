// Bundle the preload into one self-contained file, and refuse to ship it if
// it is not.
//
// Every window in this app runs with `sandbox: true`. A sandboxed preload does
// not get Node's `require`: it gets Electron's small stand-in, which loads
// `electron` and a few Node built-ins and nothing else — no relative paths.
// tsc leaves imports as it finds them, so the preload it emitted required
// `../shared/ipc.js` and died on load. Result: no `window.beeflow`, and a
// first-run page whose Connect button did nothing on any platform.
//
// esbuild inlines the shared channel list instead. The check at the end fails
// the build if anything but `electron` is required, so the next import added
// to the preload cannot bring the problem back quietly.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist/preload/index.js');

await build({
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile,
    bundle: true,
    // The sandbox's `require` is CommonJS-shaped; an ES module preload would
    // need `sandbox: false`, which is not a trade worth making.
    format: 'cjs',
    platform: 'node',
    // The renderer's V8, not the main process's Node.
    target: 'chrome130',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'warning',
});

// What the sandbox's require can load. `electron` is the only one the preload
// has any business with.
const ALLOWED = new Set(['electron']);

const code = await readFile(outfile, 'utf8');
const problems = [];
for (const match of code.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
    const argument = match[1];
    const literal = /^(['"`])([^'"`]+)\1$/.exec(argument);
    if (!literal) problems.push(`a dynamic require(${argument})`);
    else if (!ALLOWED.has(literal[2])) problems.push(`require("${literal[2]}")`);
}
if (problems.length > 0) {
    console.error(`build-preload: dist/preload/index.js must require nothing but electron under sandbox: true, and it has ${problems.join(', ')}.`);
    process.exit(1);
}
console.log('bundled preload -> dist/preload/index.js (requires: electron only)');

/**
 * A throwaway source tree with several roots, for the tests of server/moduleRoots.cjs.
 *
 * The resolver computes its core root from its own location, so it cannot be pointed at a
 * fixture: the kit copies moduleRoots.cjs and modules/roots/*.cjs into the fixture's core
 * root and runs a probe file there in a child process (one process per probe, with a clean
 * environment: no NODE_OPTIONS, BEEFLOW_MODULE_ROOTS or BEEFLOW_HIDE_MODULES unless asked).
 *
 *     <tmp>/core/                 the core root (moduleRoots.cjs, node_modules/, probe/)
 *     <tmp>/modules/<id>/server/  the module roots, found as ../modules beside the core
 *     <tmp>/scripts/module-map.mjs  only when a test gives one (core mode)
 *
 * A probe is CommonJS (or ESM with `esm: true`) and reports through `out(value)`, which
 * prints JSON on stdout; `runProbe` returns it parsed.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..');
const SCRUBBED = ['NODE_OPTIONS', 'BEEFLOW_MODULE_ROOTS', 'BEEFLOW_HIDE_MODULES', 'NODE_TEST_CONTEXT'];

/**
 * @param {string} base directory
 * @param {Record<string, string>} files relative path -> text
 */
function writeFiles(base, files) {
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(base, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
}

/**
 * Build a fixture: the resolver in core/, plus the given files (paths relative to the
 * fixture directory, so `core/...`, `modules/m1/server/...`, `scripts/...`).
 * @param {Record<string, string>} files
 * @returns {{ dir: string, core: string, moduleRoot: (id: string) => string, remove: () => void }}
 */
function buildFixture(files) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'module-roots-')));
    const core = path.join(dir, 'core');
    fs.mkdirSync(path.join(core, 'modules', 'roots'), { recursive: true });
    fs.copyFileSync(path.join(SERVER, 'moduleRoots.cjs'), path.join(core, 'moduleRoots.cjs'));
    for (const name of fs.readdirSync(path.join(SERVER, 'modules', 'roots'))) {
        if (name.endsWith('.cjs')) {
            fs.copyFileSync(path.join(SERVER, 'modules', 'roots', name), path.join(core, 'modules', 'roots', name));
        }
    }
    writeFiles(dir, { 'core/package.json': '{ "type": "commonjs" }\n', ...files });
    return {
        dir,
        core,
        moduleRoot: (id) => path.join(dir, 'modules', id, 'server'),
        remove: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

const PRELUDE = 'const out = (v) => process.stdout.write(JSON.stringify(v));\n';

/**
 * Write a probe into <core>/probe/ and run it.
 * @param {{ core: string }} fx
 * @param {string} name file name without extension
 * @param {string} code body; `out(value)` reports, `ROOTS_LIB` is the absolute path of the copied resolver
 * @param {{ env?: Record<string, string>, preload?: boolean, viaNodeOptions?: boolean, esm?: boolean }} [opts]
 *   preload: `node --require <resolver>` (default true); viaNodeOptions: through NODE_OPTIONS instead
 * @returns {{ status: number | null, value: any, stderr: string, stdout: string }}
 */
function runProbe(fx, name, code, opts = {}) {
    const { env = {}, preload = true, viaNodeOptions = false, esm = false } = opts;
    const lib = path.join(fx.core, 'moduleRoots.cjs');
    const file = path.join(fx.core, 'probe', `${name}.${esm ? 'mjs' : 'js'}`);
    const header = `${PRELUDE}const ROOTS_LIB = ${JSON.stringify(lib)};\n`;
    writeFiles(fx.core, { [path.relative(fx.core, file)]: header + code });
    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...process.env };
    for (const key of SCRUBBED) delete childEnv[key];
    Object.assign(childEnv, env);
    const args = [];
    if (preload && viaNodeOptions) childEnv.NODE_OPTIONS = `--require=${lib}`;
    else if (preload) args.push('--require', lib);
    const r = spawnSync(process.execPath, [...args, file], { cwd: fx.core, env: childEnv, encoding: 'utf8', timeout: 15000 });
    let value;
    try {
        value = r.stdout ? JSON.parse(r.stdout) : undefined;
    } catch {
        value = undefined;
    }
    return { status: r.status, value, stderr: r.stderr, stdout: r.stdout };
}

module.exports = { buildFixture, runProbe, writeFiles };

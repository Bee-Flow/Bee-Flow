// @typecheck strict
/**
 * A throwaway two-root tree for the i18n loaders (en/index.js, nl/index.js): a core root
 * with a copy of the resolver (moduleRoots.cjs, modules/roots/) and of the loader under
 * test, and one module root "x" beside it. The loader runs in a child process with
 * BEEFLOW_MODULE_ROOTS pointing at the module parent, so the roots are those of the
 * fixture and nothing of this checkout leaks in.
 *
 *   const tree = i18nTreeFixture('en', { core: { 'a.js': '…' }, module: { 'b.js': '…' } });
 *   tree.run(script, { hide: 'x' })   // the JSON the script writes to stdout
 *   tree.remove()
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..', '..');
const COPIED = ['moduleRoots.cjs', 'modules/roots/rootSet.cjs', 'modules/roots/resolveHooks.cjs',
    'modules/roots/treeCheck.cjs', 'i18n/defaults/namespaceName.js'];

/**
 * @param {string} dir
 * @param {Record<string, string>} files name -> content
 */
function writeFiles(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

/**
 * @param {'en' | 'nl'} locale which loader: i18n/defaults/<locale>/index.js
 * @param {{ core: Record<string, string>, module: Record<string, string> }} files the data files of each root
 */
function i18nTreeFixture(locale, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `i18n-${locale}-roots-`));
    const core = path.join(dir, 'core', 'server');
    const parent = path.join(dir, 'modules');
    const rel = path.join('i18n', 'defaults', locale);
    for (const file of [...COPIED, path.join(rel, 'index.js')]) {
        fs.mkdirSync(path.dirname(path.join(core, file)), { recursive: true });
        fs.copyFileSync(path.join(SERVER, file), path.join(core, file));
    }
    writeFiles(path.join(core, rel), files.core);
    writeFiles(path.join(parent, 'x', 'server', rel), files.module);

    /**
     * @param {string} script run with the core root as working directory
     * @param {{ hide?: string }} [opts] hide: BEEFLOW_HIDE_MODULES for the child (core mode)
     * @returns {any} what the script wrote to stdout, parsed as JSON
     */
    function run(script, opts = {}) {
        const env = { ...process.env, BEEFLOW_MODULE_ROOTS: parent, BEEFLOW_HIDE_MODULES: opts.hide || '' };
        return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: core, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    }

    return {
        core,
        moduleDir: path.join(parent, 'x', 'server', rel),
        run,
        remove: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

module.exports = { i18nTreeFixture };

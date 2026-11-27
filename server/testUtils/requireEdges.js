// @typecheck strict
'use strict';

/**
 * Which production files of the server's tree require which modules, read as text.
 * Guard tests use it to pin who may reach a sensitive module (for example the
 * chat-signals recorder) without loading the code.
 *
 *   requireEdges({ targets: new Set(['core/privacy/chatSignals']) })
 *     → [{ from: 'index.js', to: 'core/privacy/chatSignals' }, …]
 *
 * Paths are posix TREE paths (relative to the root that holds the file: server/ or a
 * modules/<id>/server, testUtils/serverTree.js), so a caller that moves to a module keeps
 * its name; `to` has no .js suffix. Only relative requires count, and test files are skipped.
 */

const path = require('node:path');
const fs = require('node:fs');
const { walkServerTree } = require('./serverTree');

const SERVER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SKIP = new Set(['node_modules', 'migrations', 'prompts', 'assets', 'coverage']);
const REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * The production .js files of every root, in walk order.
 * @param {Set<string>} [skip] directory names skipped at any depth
 * @returns {import('./serverTree').TreeFile[]}
 */
function productionFiles(skip = DEFAULT_SKIP) {
    return walkServerTree({
        skipDirs: [...skip],
        controlFiles: true,
        filter: (_rel, e) => !e.name.startsWith('.') && (e.isDirectory() || (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name))),
    });
}

/**
 * @param {{ targets: Set<string>, skip?: Set<string> }} opts
 * @returns {Array<{ from: string, to: string }>}
 */
function requireEdges({ targets, skip = DEFAULT_SKIP }) {
    /** @type {Array<{ from: string, to: string }>} */
    const out = [];
    for (const file of productionFiles(skip)) {
        const from = file.treePath;
        for (const m of fs.readFileSync(file.abs, 'utf8').matchAll(REQUIRE)) {
            const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), /** @type {string} */ (m[1]))).replace(/\.js$/, '');
            if (targets.has(to)) out.push({ from, to });
        }
    }
    return out;
}

module.exports = { requireEdges, productionFiles, SERVER_ROOT };

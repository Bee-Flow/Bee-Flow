'use strict';

/**
 * Which production files under server/ require which modules, read as text.
 * Guard tests use it to pin who may reach a sensitive module (for example the
 * chat-signals recorder) without loading the code.
 *
 *   requireEdges({ targets: new Set(['core/privacy/chatSignals']) })
 *     → [{ from: 'index.js', to: 'core/privacy/chatSignals' }, …]
 *
 * Paths are posix and relative to server/; `to` has no .js suffix. Only
 * relative requires count, and test files are skipped.
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SKIP = new Set(['node_modules', 'migrations', 'prompts', 'assets', 'coverage']);
const REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function productionFiles(dir, skip = DEFAULT_SKIP, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!skip.has(e.name)) productionFiles(full, skip, out); }
        else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(full);
    }
    return out;
}

function requireEdges({ targets, root = SERVER_ROOT, skip = DEFAULT_SKIP }) {
    const out = [];
    for (const file of productionFiles(root, skip)) {
        const from = path.relative(root, file).split(path.sep).join('/');
        for (const m of fs.readFileSync(file, 'utf8').matchAll(REQUIRE)) {
            const to = path.relative(root, path.resolve(path.dirname(file), m[1])).split(path.sep).join('/').replace(/\.js$/, '');
            if (targets.has(to)) out.push({ from, to });
        }
    }
    return out;
}

module.exports = { requireEdges, productionFiles, SERVER_ROOT };

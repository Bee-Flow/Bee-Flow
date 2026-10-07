'use strict';

/**
 * Guard: chat signals never count messages between people (amendment 24).
 *
 * Project team chats, comment threads, support, Nextcloud Talk and the
 * Nextcloud task processing all carry messages written by people for people.
 * None of them may reach the recorder. This walks the source tree the way
 * layering.test.js does, derives every edge into core/privacy/chatSignals (or
 * a future core/privacy/chatHints) from those areas, and asserts that the
 * derived list is empty.
 *
 * Run: cd server && node --test core/privacy/chatSignals.guard.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGETS = new Set(['core/privacy/chatSignals', 'core/privacy/chatHints']);
const SKIP = new Set(['node_modules', 'migrations', 'prompts', 'assets']);

/** Areas between people, as path prefixes relative to server/. */
const HUMAN_TO_HUMAN_AREAS = [
    'routes/projects/', 'projects/', 'routes/support', 'services/support',
    'integrations/nextcloudTalk', 'routes/nextcloudTaskProcessing.js',
];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, out); }
        else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(full);
    }
    return out;
}

const REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Every (file -> target) edge into the recorder, as posix paths relative to server/. */
function edgesIntoRecorder() {
    const out = [];
    for (const file of walk(ROOT)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        for (const m of fs.readFileSync(file, 'utf8').matchAll(REQUIRE)) {
            const target = path.relative(ROOT, path.resolve(path.dirname(file), m[1])).split(path.sep).join('/').replace(/\.js$/, '');
            if (TARGETS.has(target)) out.push({ from: rel, to: target });
        }
    }
    return out;
}

const EDGES = edgesIntoRecorder();

test('nothing that carries messages between people requires the chat signals recorder', () => {
    const bad = EDGES
        .filter(e => HUMAN_TO_HUMAN_AREAS.some(a => e.from.startsWith(a)))
        .map(e => `${e.from} -> ${e.to}`);
    assert.deepEqual(bad, []);
});

test('the walk sees the tree (the guard is not vacuous)', () => {
    // index.js wires the shutdown flush, so at least that edge must be found.
    assert.ok(EDGES.some(e => e.from === 'index.js' && e.to === 'core/privacy/chatSignals'), 'the derived edge list is empty: the walk is broken');
});

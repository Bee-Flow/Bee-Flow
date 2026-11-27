'use strict';
/**
 * testUtils/mountRowsText.js: a loader mount call in a host file reads as the use() calls of
 * the mount rows, per slot and in order-index order, with the rows' requires rebased.
 *
 * Run: cd server && node --test testUtils/mountRowsText.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { expandMountCalls, rowsOf } = require('./mountRowsText');
const { parseRequires, stripComments } = require('./routeSurfaceSweep');

// The fixture's require() texts are built, so importPaths.test.js does not take them for this
// file's own requires.
/** @param {string} spec */
const R = (spec) => `require('${spec}')`;

const PARTS = {
    'firstParty/a.mounts.js': `const mounts = [
    // a comment between rows
    { key: 'a:/x', slot: 'main', path: '/x', handlers: (g) => [g.requireModule('a'), ${R('../routes/x')}] },
    { key: 'a:fallback', slot: 'fallback', path: null, handlers: () => [${R('../routes/render')}] },
];
const aiMounts = [{ key: 'a:/ai', path: '/ai-a', handlers: () => [${R('../routes/ai/a')}] }];
module.exports = { mounts, aiMounts };`,
    'firstParty/b.mounts.js': `const mounts = [{ key: 'b:/y', slot: 'main', path: '/y', handlers: () => [${R('../routes/y')}] }];
module.exports = { mounts };`,
};

/** @param {string | null} src @param {string} host */
const expand = (src, host) => expandMountCalls(src, host, {
    strip: stripComments, requiresOf: parseRequires,
    parts: () => Object.entries(PARTS).map(([file, text]) => ({ file, text })), order: { mounts: ['b:/y', 'a:/x'], aiMounts: [] },
});

test('rows are read from their object literals', () => {
    const rows = rowsOf(stripComments(PARTS['firstParty/a.mounts.js']), 'firstParty/a.mounts.js');
    assert.deepEqual(rows.map((row) => [row.key, row.slot, row.path]), [['a:/x', 'main', "'/x'"], ['a:fallback', 'fallback', null], ['a:/ai', null, "'/ai-a'"]]);
});

test('a slot call becomes one use() per row of that slot, in order-index order, requires rebased', () => {
    const host = `const firstParty = ${R('./modules/firstParty/loader')};\nfirstParty.mount(app, gates, 'main');\nfirstParty.mount(app, gates, 'fallback');\n`;
    const lines = expand(host, 'index.js').split('\n');
    assert.deepEqual(lines.slice(1, 4), [
        `app.use('/y', ${R('./routes/y')});`,
        `app.use('/x', g.requireModule('a'), ${R('./routes/x')});`,
        `app.use(${R('./routes/render')});`,
    ]);
});

test('mountAi takes the rows without a slot, relative to the host file', () => {
    const host = `const firstParty = ${R('../modules/firstParty/loader')};\nfirstParty.mountAi(router, aiGates());\n`;
    assert.equal(expand(host, 'routes/ai.js').split('\n')[1], `router.use('/ai-a', ${R('./ai/a')});`);
});

test('a file without the loader is left alone, and null passes through', () => {
    const src = "other.mount(app, gates, 'main');";
    assert.equal(expand(src, 'index.js'), src);
    assert.equal(expand(null, 'index.js'), null);
});

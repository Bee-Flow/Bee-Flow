'use strict';
/**
 * boot/migrationLadder.js: a listed migration whose module is not here is skipped silently
 * (reported as absent, never failed, never recorded), any other missing file still fails, and
 * the record of module-owned migrations (modules/firstParty/migrationOwners.json) agrees with
 * scripts/module-map.json and with the compositions that contribute them.
 *
 * Run: cd server && node --test boot/migrationLadder.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runList, absentModule } = require('./migrationLadder');
const OWNERS = require('../modules/firstParty/migrationOwners.json');
const ORDER = require('../modules/firstParty/order.json');
const { NL_TRANSLATIONS } = require('./bootMigrations');

const SERVER = path.resolve(__dirname, '..');
const quiet = { warn() {}, log() {} };

/**
 * runList over `names` with every migration a recorder and an empty in-memory ledger.
 * @param {string[]} names
 * @param {(name: string) => string | null} absentOf
 */
async function ladder(names, absentOf) {
    /** @type {string[]} */
    const ran = [];
    /** @type {string[]} */
    const recorded = [];
    const out = await runList(names, {
        log: quiet,
        absentOf,
        load: (name) => ({ up: async () => { ran.push(name); } }),
        ledger: { read: async () => new Map(), record: async (name) => { recorded.push(name); } },
    });
    return { out, ran, recorded };
}

test('a name whose module is not here is absent: not run, not recorded, not failed', async () => {
    const { out, ran, recorded } = await ladder(['memory-guest-purge-2026-08', 'prompt-tasks-to-cowork-2026-08'],
        (name) => (name === 'prompt-tasks-to-cowork-2026-08' ? 'cowork' : null));
    assert.deepEqual(out.absent, ['prompt-tasks-to-cowork-2026-08']);
    assert.deepEqual(out.failed, []);
    assert.deepEqual(ran, ['memory-guest-purge-2026-08']);
    assert.deepEqual(recorded, ['memory-guest-purge-2026-08']);
});

test('a missing file that no module owns still fails, as before', async () => {
    const { out, ran } = await ladder(['no-such-migration-2099-01'], (name) => absentModule(name, {}));
    assert.deepEqual(out.absent, []);
    assert.deepEqual(out.failed.map((f) => f.name), ['no-such-migration-2099-01']);
    assert.deepEqual(ran, []);
});

test('absentModule: a present file is here; a missing one is blamed only on its recorded owner', () => {
    assert.equal(absentModule('memory-guest-purge-2026-08'), null);
    assert.equal(absentModule('no-such-migration-2099-01', {}), null);
    assert.equal(absentModule('no-such-migration-2099-01', { 'no-such-migration-2099-01': 'cowork' }), 'cowork');
});

test('in core mode a hidden module\'s migration is absent, a core one runs, an unowned missing one fails', () => {
    const code = [
        `const { runList } = require(${JSON.stringify(require.resolve('./migrationLadder'))});`,
        'runList(["prompt-tasks-to-cowork-2026-08", "memory-guest-purge-2026-08", "no-such-migration-2099-01"], {',
        '    log: { warn() {}, log() {} }, load: () => ({ up: async () => {} }),',
        '    ledger: { read: async () => new Map(), record: async () => {} },',
        '}).then((out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); });',
    ].join('\n');
    const env = { ...process.env, BEEFLOW_HIDE_MODULES: 'cowork' };
    const r = spawnSync(process.execPath, ['--require', './moduleRoots.cjs', '-e', code], { cwd: SERVER, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.absent, ['prompt-tasks-to-cowork-2026-08']);
    assert.deepEqual(out.ok, ['memory-guest-purge-2026-08']);
    assert.deepEqual(out.failed.map((/** @type {{ name: string }} */ f) => f.name), ['no-such-migration-2099-01']);
});

test('migrationOwners.json names exactly the ladder\'s migrations that scripts/module-map.json gives to a module', async () => {
    const { loadModuleMap } = await import(path.join(SERVER, '..', 'scripts', 'module-map.mjs'));
    const map = loadModuleMap();
    /** @param {string[]} names */
    const owned = (names) => Object.fromEntries(names.map((n) => [n, map.ownerOf('server', `migrations/${n}.js`)]).filter(([, owner]) => owner));
    assert.deepEqual(OWNERS.migrations, owned(ORDER.migrations));
    assert.deepEqual(OWNERS.nlTranslations, owned(NL_TRANSLATIONS));
});

test('every migration a composition contributes is recorded under that composition\'s module', () => {
    const { listTreeDir } = require('../moduleRoots.cjs');
    /** @type {Record<string, string>} */
    const contributed = {};
    // The compositions of the tree; in core mode the hidden ones are not listed, nor compared.
    const seen = new Set();
    for (const { name, abs } of listTreeDir('firstParty')) {
        const id = (/^(\w+)\.js$/.exec(name) || [])[1];
        if (id) seen.add(id);
        const m = /^(\w+)\.stores\.js$/.exec(name);
        if (!m) continue;
        for (const migration of require(abs).migrations || []) contributed[migration] = /** @type {string} */ (m[1]);
    }
    assert.deepEqual(contributed, Object.fromEntries(Object.entries(OWNERS.migrations).filter(([, id]) => seen.has(id))));
});

'use strict';

/**
 * boot/storeSchemas.js — the warm-up, and the guard that keeps DDL out of
 * require time.
 *
 * The behaviour half runs against injected modules (no database, no fleet
 * load). The guard half is static: it re-reads stores/ and fails when a store
 * starts its own schema at module level again, which is exactly the shape this
 * change removed. Five data migrations are allowed by name — they are not
 * schema, and when they should move is a separate decision.
 *
 * Run: cd server && node --test --test-force-exit boot/storeSchemas.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { startStoreSchemas } = require('./storeSchemas');

const quietLog = { info() {}, warn() {}, error() {} };

test('every registered store gets its init started, in registry order', () => {
    const calls = [];
    const mods = {
        'a': { initDB: () => { calls.push('a'); return Promise.resolve(); } },
        'b': { initDB: () => { calls.push('b'); return Promise.resolve(); } },
    };
    const report = startStoreSchemas({
        log: quietLog,
        modules: [{ name: 'a', file: 'a' }, { name: 'b', file: 'b' }],
        load: (f) => mods[f],
    });
    assert.deepStrictEqual(calls, ['a', 'b']);
    assert.deepStrictEqual(report.started, ['a', 'b']);
});

test('a store exposing only `ready` is started through it', () => {
    let reads = 0;
    const mod = { get ready() { reads += 1; return Promise.resolve(); } };
    const report = startStoreSchemas({
        log: quietLog, modules: [{ name: 'mcpStore', file: 'm' }], load: () => mod,
    });
    assert.strictEqual(reads > 0, true, 'the getter is what starts the init');
    assert.deepStrictEqual(report.started, ['mcpStore']);
});

test('a rejected init is counted as started and never becomes an unhandled rejection', async () => {
    const report = startStoreSchemas({
        log: quietLog,
        modules: [{ name: 'broken', file: 'b' }],
        load: () => ({ initDB: () => Promise.reject(new Error('DB down')) }),
    });
    assert.deepStrictEqual(report.started, ['broken']);
    await new Promise((r) => setImmediate(r));   // an unswallowed rejection would crash here
});

test('a store that cannot be loaded is reported, and the rest still start', () => {
    const started = [];
    const report = startStoreSchemas({
        log: quietLog,
        modules: [{ name: 'boom', file: 'boom' }, { name: 'fine', file: 'fine' }],
        load: (f) => {
            if (f === 'boom') throw new Error('syntax error');
            return { initDB: () => { started.push(f); return Promise.resolve(); } };
        },
    });
    assert.deepStrictEqual(report.failed, ['boom']);
    assert.deepStrictEqual(started, ['fine']);
});

test('a store with no awaitable init is named, not silently skipped', () => {
    const report = startStoreSchemas({
        log: quietLog, modules: [{ name: 'plain', file: 'p' }], load: () => ({}),
    });
    assert.deepStrictEqual(report.unverified, ['plain']);
    assert.deepStrictEqual(report.started, []);
});

// ── the guard ──────────────────────────────────────────────────────────

// Not schema: one-shot data migrations and default-row seeds. Their move out
// of require time is its own piece of work, so they are allowed BY NAME here
// rather than by shape — a new `initSomething()` at module level still fails.
const ALLOWED_AT_REQUIRE_TIME = new Set([
    'migrateConfigJson',              // configStore: legacy config.json → table
    'reencryptLegacyPlaintextSecrets', // configStore: re-wrap plaintext secrets
    'initDefaultGroups',              // user/groups: seeds the default group rows
    'initDefaultRoles',               // user/roles: seeds the default role rows
    'migrateJsonToDb',                // user/schema: legacy users.json → table
]);

// A module-level `fn()` whose result is only .catch/.then-ed, or parked in a
// const — the two shapes the stores used to start their schema with.
const KICKOFF = /^(?:const \w+ = )?([A-Za-z_$][\w$]*)\(\)\s*\.(?:catch|then)\(/gm;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(full);
    }
    return out;
}

test('no store starts its schema at require time', () => {
    const storesDir = path.join(__dirname, '..', 'stores');
    const offenders = [];
    for (const file of walk(storesDir)) {
        const src = fs.readFileSync(file, 'utf8');
        KICKOFF.lastIndex = 0;
        let m;
        while ((m = KICKOFF.exec(src)) !== null) {
            if (ALLOWED_AT_REQUIRE_TIME.has(m[1])) continue;
            offenders.push(`${path.relative(storesDir, file).replace(/\\/g, '/')}  ->  ${m[1]}()`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'these stores run work at module level again. Schema belongs in initDB(),\n' +
        'which boot/storeSchemas.js starts and every store function awaits:\n  ' + offenders.join('\n  '));
});

test('the allow-list still names functions that exist', () => {
    const src = walk(path.join(__dirname, '..', 'stores')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const fn of ALLOWED_AT_REQUIRE_TIME) {
        assert.match(src, new RegExp(`function ${fn}\\b`), `allow-list names a vanished function: ${fn}`);
    }
});

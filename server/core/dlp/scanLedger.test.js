'use strict';
/**
 * The ledger's safety rests on one rule — only a verdict with guard-supplied
 * provenance may be written — and on the key covering everything that can
 * change the answer. Both are pinned here, because with no expiry a wrong row
 * is permanent.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// The ledger's HMAC key has no literal fallback, so a standalone run of this
// file (node --test core/dlp/scanLedger.test.js) needs the secret the shared
// runner would otherwise provide.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-scan-ledger-at-least-32c';

// Stub the store BEFORE requiring the module under test.
const storePath = path.join(__dirname, '..', '..', 'stores', 'piiScanLedgerStore.js');
const store = require(storePath);
const rows = new Map();
store.getMany = async (keys) => {
    const out = new Map();
    for (const k of keys) if (rows.has(k)) out.set(k, rows.get(k));
    return out;
};
store.putMany = async (list) => {
    for (const r of list) rows.set(r.key, { entities: r.entities, charLen: r.charLen });
};

const { detectWithLedger, scanKey } = require('./scanLedger');

const FP = 'engine-abc123';
function makeDetect({ fingerprint = FP, degraded = false, entities = () => [] } = {}) {
    const calls = [];
    const fn = async (text) => {
        calls.push(text);
        const list = entities(text);
        return {
            hasPii: list.length > 0, entities: list,
            degraded, degradedReason: degraded ? 'guard_unreachable: boom' : null,
            engineFingerprint: degraded ? null : fingerprint,
        };
    };
    fn.calls = calls;
    return fn;
}

const LONG = (() => {
    let s = '';
    let i = 0;
    while (s.length < 40_000) { s += `paragraph ${i} with some ordinary prose in it. `; if (i % 6 === 0) s += '\n\n'; i++; }
    return s;
})();

test.beforeEach(() => rows.clear());

test('second pass over unchanged text issues far fewer guard calls', async () => {
    const d1 = makeDetect();
    const r1 = await detectWithLedger(LONG, { categories: ['Person'], threshold: 0.7, detect: d1 });
    assert.ok(r1.stats.segments > 3, 'precondition: text must segment');
    assert.strictEqual(r1.stats.hits, 0);

    const d2 = makeDetect();
    const r2 = await detectWithLedger(LONG, { categories: ['Person'], threshold: 0.7, detect: d2 });
    assert.strictEqual(r2.stats.hits, r2.stats.segments - 1,
        'every segment but the identity probe must come from the ledger');
    assert.ok(d2.calls.length < d1.calls.length / 2,
        `expected a large drop in guard calls, got ${d2.calls.length} vs ${d1.calls.length}`);
});

test('entity offsets from a hit are absolute and identical to a fresh scan', async () => {
    const needle = 'Gerard de Groot';
    const at = LONG.indexOf('paragraph 9');
    const text = LONG.slice(0, at) + needle + LONG.slice(at);
    const ents = (chunk) => {
        const i = chunk.indexOf(needle);
        return i === -1 ? [] : [{ offset: i, length: needle.length, category: 'Person', label: 'Person Name', confidence: 0.95 }];
    };
    const fresh = await detectWithLedger(text, { categories: null, threshold: 0.7, detect: makeDetect({ entities: ents }) });
    const cached = await detectWithLedger(text, { categories: null, threshold: 0.7, detect: makeDetect({ entities: ents }) });

    assert.ok(fresh.entities.length >= 1);
    assert.deepStrictEqual(
        cached.entities.map(e => [e.offset, e.length, e.category]).sort(),
        fresh.entities.map(e => [e.offset, e.length, e.category]).sort(),
    );
    for (const e of cached.entities) {
        assert.strictEqual(text.slice(e.offset, e.offset + e.length), needle,
            'a cached offset must still point at the value it described');
    }
});

test('a result without guard provenance is never written', async () => {
    const d = makeDetect({ fingerprint: null });
    await detectWithLedger(LONG, { categories: null, threshold: 0.7, detect: d });
    assert.strictEqual(rows.size, 0, 'no fingerprint means the guard did not vouch for this answer');
});

test('a degraded result is never written', async () => {
    const d = makeDetect({ degraded: true });
    const r = await detectWithLedger(LONG, { categories: null, threshold: 0.7, detect: d });
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(rows.size, 0);
});

test('detectPii returning null degrades and writes nothing', async () => {
    const d = async () => null;
    const r = await detectWithLedger(LONG, { categories: null, threshold: 0.7, detect: d });
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(r.degradedReason, 'guard_not_installed');
    assert.strictEqual(rows.size, 0);
});

test('the key changes with text, categories, threshold, engine and scope', async () => {
    const base = { text: 'some text', categories: ['Person'], threshold: 0.7, engineFingerprint: FP, scope: 'g' };
    const k = scanKey(base);
    assert.notStrictEqual(k, scanKey({ ...base, text: 'some texu' }));
    assert.notStrictEqual(k, scanKey({ ...base, categories: ['Person', 'Email'] }));
    assert.notStrictEqual(k, scanKey({ ...base, threshold: 0.8 }));
    assert.notStrictEqual(k, scanKey({ ...base, engineFingerprint: 'other' }));
    assert.notStrictEqual(k, scanKey({ ...base, scope: 'org:1' }));
    assert.strictEqual(k, scanKey({ ...base }), 'same inputs must be stable');
});

test('null categories is a different key from an explicit list', async () => {
    const base = { text: 'x', threshold: 0.7, engineFingerprint: FP, scope: 'g' };
    assert.notStrictEqual(
        scanKey({ ...base, categories: null }),
        scanKey({ ...base, categories: ['Person', 'Email'] }),
        '"everything the guard knows" is not the same request as an explicit list',
    );
});

test('an engine upgrade invalidates every row', async () => {
    await detectWithLedger(LONG, { categories: null, threshold: 0.7, detect: makeDetect({ fingerprint: 'v1' }) });
    const after = makeDetect({ fingerprint: 'v2' });
    const r = await detectWithLedger(LONG, { categories: null, threshold: 0.7, detect: after });
    assert.strictEqual(r.stats.hits, 0, 'a new engine must not inherit the old engine\'s verdicts');
});

test('the ledger never stores a personal-data string', async () => {
    const needle = 'Gerard de Groot';
    const text = LONG.replace('paragraph 9', `paragraph 9 ${needle}`);
    await detectWithLedger(text, {
        categories: null, threshold: 0.7,
        detect: makeDetect({
            entities: (chunk) => {
                const i = chunk.indexOf(needle);
                return i === -1 ? [] : [{ offset: i, length: needle.length, category: 'Person', text: needle }];
            },
        }),
    });
    const dump = JSON.stringify([...rows.values()]);
    assert.ok(!dump.includes(needle), 'offsets only — a value must never reach the table');
    assert.ok(!dump.includes('Gerard'), 'not even a fragment');
});

test('a store that throws behaves exactly like a cold cache', async () => {
    const saved = store.getMany;
    store.getMany = async () => { throw new Error('db down'); };
    try {
        const d = makeDetect();
        const r = await detectWithLedger(LONG, { categories: null, threshold: 0.7, detect: d });
        assert.strictEqual(r.degraded, false, 'a storage failure is not a detection failure');
        assert.strictEqual(r.stats.hits, 0);
    } finally { store.getMany = saved; }
});

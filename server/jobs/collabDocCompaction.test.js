/**
 * The co-editing upkeep job (jobs/collabDocCompaction.js), with every
 * dependency injected through _setDeps: no store, no pool, no timers.
 *
 * Proven: one pod per pass (a lock held elsewhere skips the pass, and the lock
 * is released after a pass); every document with work is processed and a
 * failing one is logged by id and does not stop the others; overlapping
 * passes on one pod do not run twice; the lock key is its own.
 *
 * The per-document work itself is proven in core/collab/lifecycle.test.js.
 *
 * Run: cd server && node --test jobs/collabDocCompaction.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const job = require('./collabDocCompaction');

function harness({ locked = true, docs = [], fail = new Set() } = {}) {
    const calls = [];
    const warnings = [];
    const client = {
        async query(sql, params) {
            calls.push([sql.includes('unlock') ? 'unlock' : 'lock', params[0]]);
            return { rows: [{ locked }] };
        },
        release() { calls.push(['release']); },
    };
    const processed = [];
    job._setDeps({
        pool: { connect: async () => client },
        listWork: async () => docs,
        processDoc: async (doc) => {
            if (fail.has(doc.id)) throw new Error('key unavailable');
            processed.push(doc.id);
        },
        log: { warn: (...a) => warnings.push(a.join(' ')), info() {} },
    });
    return { calls, warnings, processed };
}

test.afterEach(() => job._setDeps());

test('a pass processes every document with work, under the lock, and releases it', async () => {
    const h = harness({ docs: [{ id: 'a' }, { id: 'b' }] });
    const r = await job.runOnce();
    assert.deepStrictEqual(r, { processed: 2, failed: 0 });
    assert.deepStrictEqual(h.processed, ['a', 'b']);
    assert.deepStrictEqual(h.calls, [['lock', job.COLLAB_COMPACTION_LOCK_KEY], ['unlock', job.COLLAB_COMPACTION_LOCK_KEY], ['release']]);
});

test('another pod holding the lock skips the pass', async () => {
    const h = harness({ locked: false, docs: [{ id: 'a' }] });
    const r = await job.runOnce();
    assert.strictEqual(r.skipped, true);
    assert.deepStrictEqual(h.processed, []);
    assert.deepStrictEqual(h.calls.map((c) => c[0]), ['lock', 'release'], 'not unlocked: never held');
});

test('a failing document is logged by id and the others still run', async () => {
    const h = harness({ docs: [{ id: 'a' }, { id: 'bad' }, { id: 'c' }], fail: new Set(['bad']) });
    const r = await job.runOnce();
    assert.deepStrictEqual(r, { processed: 2, failed: 1 });
    assert.deepStrictEqual(h.processed, ['a', 'c']);
    assert.ok(h.warnings.some((line) => line.includes('document bad failed')));
});

test('overlapping passes on one pod do not run twice', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const processed = [];
    job._setDeps({
        pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} }) },
        listWork: async () => [{ id: 'a' }],
        processDoc: async (doc) => { await gate; processed.push(doc.id); },
        log: { warn() {}, info() {} },
    });
    const first = job.runOnce();
    const second = await job.runOnce();
    assert.strictEqual(second.skipped, true);
    release();
    await first;
    assert.deepStrictEqual(processed, ['a']);
});

test('the advisory lock key is not used by any other job', () => {
    const hex = `0x${job.COLLAB_COMPACTION_LOCK_KEY.toString(16).toUpperCase()}`;
    const dir = __dirname;
    const others = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.js') && !f.startsWith('collabDocCompaction'))
        .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').toUpperCase().includes(hex));
    assert.deepStrictEqual(others, []);
});

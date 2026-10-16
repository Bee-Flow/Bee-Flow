'use strict';
// The flush uploads only a single-file database: a handle whose journal mode
// is no longer DELETE is refused before anything is read or uploaded.

const test = require('node:test');
const assert = require('node:assert');
const { createFlusher } = require('./sqliteBlobFlush');

function setup(journalMode) {
    const calls = { query: 0, upload: 0 };
    const entry = {
        db: { pragma: () => journalMode },
        ownerId: 'u1', localPath: '/nonexistent/never-read.db',
        dirty: true, flushTimer: null, flushing: null, lastPersistedSha: '', poisoned: false,
    };
    const handles = new Map([['db1', entry]]);
    const { flushNow } = createFlusher({
        handles,
        dbKey: (o, id) => `k/${o}/${id}`,
        storage: { isAvailable: () => true, uploadFile: async () => { calls.upload++; } },
        runQuery: async () => { calls.query++; return { rowCount: 1 }; },
        metaTable: 'things', logPrefix: 'T', entityLabel: 'Thing DB',
    });
    return { flushNow, calls, entry };
}

for (const mode of ['wal', 'memory', 'off', 'truncate']) {
    test(`flush refuses a handle in journal mode ${mode}`, async () => {
        const { flushNow, calls, entry } = setup(mode);
        await assert.rejects(() => flushNow('db1'), /journal mode DELETE/);
        assert.deepStrictEqual(calls, { query: 0, upload: 0 });
        assert.strictEqual(entry.dirty, true, 'the handle stays dirty');
    });
}

test('flush goes ahead in journal mode delete (fails only on the missing file here)', async () => {
    const { flushNow } = setup('delete');
    await assert.rejects(() => flushNow('db1'), (err) => {
        assert.doesNotMatch(String(err.message), /journal mode DELETE/);
        return true;
    });
});

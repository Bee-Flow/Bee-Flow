'use strict';

/**
 * The compliance module's part of the chat signal retention (./retentionDays.js): the purge of
 * stores/chatSignalStore.js honours an organisation's own setting, on PGlite.
 *
 * Run: cd server && node --test stores/chatSignal/retentionDays.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { DDL, makeChatSignalStore } = require('../chatSignalStore');

const { pg, db } = pgliteDb();
const store = makeChatSignalStore(db);

before(async () => {
    await pg.exec(DDL);
    await pg.exec(`CREATE TABLE compliance_settings (organization_id TEXT PRIMARY KEY, chat_monitoring_retention_days INTEGER)`);
});
after(() => pg.close());

test('an organisation\'s own retention decides which weeks go', async () => {
    const today = (await pg.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    const shift = (n) => new Date(Date.parse(`${today}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await pg.exec(`INSERT INTO compliance_settings VALUES ('a30', 30)`);
    for (const offset of [-37, -36]) {
        await pg.query(`
            INSERT INTO chat_signal_counts (organization_id, period_start, granularity, surface, signal, value, destination, turns)
            VALUES ('a30', $1::date, 'week', 'direct', 'outcome', 'clean', 'external', 1)`, [shift(offset)]);
    }
    assert.equal(await store.purgeExpired(), 1, 'the week wholly older than 30 days');
    const { rows } = await pg.query(`SELECT period_start::text AS p FROM chat_signal_counts`);
    assert.deepEqual(rows, [{ p: shift(-36) }]);
});

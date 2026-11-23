// @typecheck
/**
 * The daily Cowork e-mail setting on a real Postgres (PGlite): off by default, the owner's own row, and a day that is
 * claimed once (two servers, or a restart in a pass, never send one day's mail twice).
 *
 * Run: cd server && node --test stores/coworkDailyMail.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeCoworkDailyMailStore, COWORK_DAILY_MAIL_DDL } = require('./coworkDailyMail.mts');

const { pg, db } = pgliteDb();
const store = makeCoworkDailyMailStore(db);

before(async () => { for (const sql of COWORK_DAILY_MAIL_DDL) await pg.exec(sql); });
after(async () => { await pg.close(); });

test('off until the owner chooses; the choice and its time zone are kept per owner', async () => {
    assert.deepStrictEqual(await store.getSetting('u-none'), { enabled: false, timeZone: 'UTC' });
    await store.setSetting('u-a', { enabled: true, timeZone: 'Europe/Amsterdam' });
    await store.setSetting('u-b', { enabled: false, timeZone: 'UTC' });
    assert.deepStrictEqual(await store.getSetting('u-a'), { enabled: true, timeZone: 'Europe/Amsterdam' });
    assert.deepStrictEqual((await store.listEnabled(10)).map((o) => o.userId), ['u-a']);
});

test('a day is claimed once, the next day again, and never while it is off', async () => {
    await store.setSetting('u-c', { enabled: true, timeZone: 'UTC' });
    assert.strictEqual(await store.claimDay('u-c', '2026-11-23'), true);
    assert.strictEqual(await store.claimDay('u-c', '2026-11-23'), false);
    assert.strictEqual((await store.listEnabled(10)).find((o) => o.userId === 'u-c')?.lastSentOn, '2026-11-23');
    assert.strictEqual(await store.claimDay('u-c', '2026-11-24'), true);
    // A day before the last one sent (a clock that went back) is no new day.
    assert.strictEqual(await store.claimDay('u-c', '2026-11-22'), false);
    await store.setSetting('u-c', { enabled: false, timeZone: 'UTC' });
    assert.strictEqual(await store.claimDay('u-c', '2026-11-25'), false);
});

test('the owners with it on come in pages by id', async () => {
    for (const id of ['p-1', 'p-2', 'p-3']) await store.setSetting(id, { enabled: true, timeZone: 'UTC' });
    const first = await store.listEnabled(2);
    const rest = await store.listEnabled(100, first[first.length - 1].userId);
    const all = [...first, ...rest].map((o) => o.userId);
    assert.deepStrictEqual(all, [...new Set(all)].sort());
    assert.ok(['p-1', 'p-2', 'p-3'].every((id) => all.includes(id)));
});

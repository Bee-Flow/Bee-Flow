// @typecheck
/**
 * "It notices what you repeat" on a real Postgres (PGlite): nothing is noted for a person who did not switch it on, or
 * for a turn that used no app; four weeks in a row on the same weekday gives one offer, once; what is stored is a hash,
 * a weekday and a week, never what was asked; switching it off forgets everything.
 *
 * Run: cd server && node --test core/cowork/habits/habitSignals.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { makeCoworkHabits, COWORK_HABITS_DDL } = require('../../../stores/coworkHabits.mts');
const { noteTurn, isoWeekOf, inARow } = require('./habitSignals.mts');
const { setHabits } = require('../../../usecases/coworkHabits.mts');

const { pg, db } = pgliteDb();
const store = makeCoworkHabits({ db: { getAll: async (sql, p) => (await db.query(sql, p)).rows, run: (sql, p) => db.query(sql, p) } });
before(async () => { for (const sql of COWORK_HABITS_DDL) await pg.exec(sql); });
after(async () => { await pg.close(); });

const MARKER = 'What are the open supplier orders this week?';
const appOf = (/** @type {string} */ n) => (n.startsWith('outlook_') ? 'outlook' : null);
const on = new Set(['ann']);
const deps = { enabled: async (/** @type {string} */ u) => on.has(u), appOf, store };
const monday = (weeksAgo) => new Date(Date.parse('2026-11-23T09:00:00Z') - weeksAgo * 7 * 86_400_000);

test('four Mondays in a row with the same kind of turn: one offer, once; three are not enough', async () => {
    const turn = (at) => noteTurn({ userId: 'ann', agentId: 'a1', toolNames: ['outlook_search', 'outlook_read'], at }, deps);
    assert.strictEqual(await turn(monday(3)), null);
    assert.strictEqual(await turn(monday(2)), null);
    assert.strictEqual(await turn(monday(1)), null);
    assert.deepStrictEqual(await turn(monday(0)), { weekday: 1, weeks: 4 });
    assert.strictEqual(await turn(monday(0)), null, 'offered once, never again');
});

test('nothing is noted for someone who did not switch it on, nor for a turn that used no app', async () => {
    assert.strictEqual(await noteTurn({ userId: 'bob', agentId: 'a1', toolNames: ['outlook_search'], at: monday(0) }, deps), null);
    await noteTurn({ userId: 'ann', agentId: 'a1', toolNames: ['set_reminder'], at: monday(0) }, deps);
    const rows = (await db.query('SELECT user_id FROM cowork_habit_signals')).rows;
    assert.ok(rows.every((r) => r.user_id === 'ann'));
    assert.strictEqual((await db.query('SELECT COUNT(*)::int AS n FROM cowork_habit_signals')).rows[0].n, 4, 'the no-app turn left no row');
});

test('a row holds a hash, a weekday and a week; never the question', async () => {
    const rows = (await db.query('SELECT * FROM cowork_habit_signals')).rows;
    assert.ok(rows.length > 0);
    for (const r of rows) {
        assert.deepStrictEqual(Object.keys(r).sort(), ['agent_id', 'created_at', 'iso_week', 'tools_hash', 'user_id', 'weekday']);
        assert.match(String(r.tools_hash), /^[0-9a-f]{64}$/);
        assert.ok(!JSON.stringify(r).includes(MARKER));
    }
});

test('switching it off forgets everything it noted', async () => {
    const config = new Map();
    await setHabits('ann', false, { getConfig: async (k) => config.get(k), setConfig: async (k, v) => { config.set(k, v); }, policyOf: async () => /** @type {any} */ ({ habitsAllowed: true }), forget: (u) => store.forget(u) });
    assert.strictEqual((await db.query('SELECT COUNT(*)::int AS n FROM cowork_habit_signals WHERE user_id = $1', ['ann'])).rows[0].n, 0);
    assert.strictEqual((await db.query('SELECT COUNT(*)::int AS n FROM cowork_habit_offers WHERE user_id = $1', ['ann'])).rows[0].n, 0);
});

test('an organisation that does not allow it: it cannot be switched on', async () => {
    await assert.rejects(setHabits('ann', true, { getConfig: async () => null, setConfig: async () => {}, policyOf: async () => /** @type {any} */ ({ habitsAllowed: false }), forget: async () => {} }), (/** @type {any} */ e) => e.status === 403);
});

test('ISO weeks: a gap breaks the row', () => {
    assert.strictEqual(isoWeekOf(new Date('2026-11-23T09:00:00Z')), '2026-W48');
    assert.strictEqual(isoWeekOf(new Date('2027-01-01T09:00:00Z')), '2026-W53');
    const at = monday(0);
    assert.strictEqual(inARow([isoWeekOf(monday(0)), isoWeekOf(monday(1)), isoWeekOf(monday(3)), isoWeekOf(monday(4))], at), false);
});

test('a Wednesday turn earlier in the week does not hide the Friday habit: four Fridays still give the offer', async () => {
    on.add('cas');
    const at = (weeksAgo, day) => new Date(Date.parse('2026-11-18T09:00:00Z') + (day === 'fri' ? 2 : 0) * 86_400_000 - weeksAgo * 7 * 86_400_000);
    const turn = (when) => noteTurn({ userId: 'cas', agentId: 'a1', toolNames: ['outlook_search'], at: when }, deps);
    let offer = null;
    for (const weeksAgo of [3, 2, 1, 0]) {
        if (weeksAgo % 2 === 1) await turn(at(weeksAgo, 'wed')); // two Wednesdays only: not a habit of their own
        offer = await turn(at(weeksAgo, 'fri'));
    }
    assert.deepStrictEqual(offer, { weekday: 5, weeks: 4 });
});

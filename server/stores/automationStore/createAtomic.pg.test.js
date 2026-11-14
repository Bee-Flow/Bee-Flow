/**
 * createAutomation and createStep write a row and its v1 version in ONE
 * transaction, against a real Postgres (PGlite behind the real db.js): when
 * the version insert fails, no automation row is left behind without a v1.
 *
 * The failure is a trigger that refuses a version row for one test user, so
 * the first insert has already run when the second one fails.
 *
 * Run: cd server && node --test stores/automationStore/createAtomic.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { createAutomation } = require('./automations');
const { createStep } = require('./steps');

const FAILING_USER = 'u-version-refused';

before(async () => {
    await require('./core').initDB();
    await pg.exec(`
        CREATE FUNCTION refuse_version() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'version insert refused';
        END $$;
        CREATE TRIGGER refuse_version BEFORE INSERT ON automation_versions
            FOR EACH ROW WHEN (NEW.saved_by_user_id = '${FAILING_USER}') EXECUTE FUNCTION refuse_version();
    `);
});
after(close);

const DEF = { trigger: { kind: 'manual', id: 't' }, steps: [] };
const count = async (sql, params) => Number((await pg.query(sql, params)).rows[0].n);
const rowsOf = (userId) => count('SELECT COUNT(*)::int AS n FROM automations WHERE user_id = $1', [userId]);

test('createAutomation: a failing version insert leaves no automation row', async () => {
    await assert.rejects(
        () => createAutomation({ userId: FAILING_USER, title: 'A', definition: DEF, triggerType: 'manual' }),
        /version insert refused/,
    );
    assert.strictEqual(await rowsOf(FAILING_USER), 0);
});

test('createAutomation: the row and its v1 land together', async () => {
    const a = await createAutomation({ userId: 'u-ok', title: 'A', definition: DEF, triggerType: 'manual' });
    assert.ok(a && a.id);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM automation_versions WHERE automation_id = $1 AND version = 1', [a.id]), 1);
});

test('createStep: a failing version insert leaves no Step row', async () => {
    await assert.rejects(
        () => createStep({ userId: FAILING_USER, title: 'S', definition: DEF }),
        /version insert refused/,
    );
    assert.strictEqual(await rowsOf(FAILING_USER), 0);
});

test('createStep: the row and its v1 land together', async () => {
    const s = await createStep({ userId: 'u-ok-step', title: 'S', definition: DEF });
    assert.ok(s && s.id);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM automation_versions WHERE automation_id = $1 AND version = 1', [s.id]), 1);
});

test('claimDueAutomations with nothing due ends its transaction once', async () => {
    const db = require('../../db');
    const connect = db.pool.connect;
    /** @type {string[]} */
    const sent = [];
    db.pool.connect = /** @type {any} */ (async () => {
        const c = await connect();
        return { query: (sql, params) => { sent.push(String(sql).trim().split(/\s+/)[0]); return c.query(sql, params); }, release: () => c.release() };
    });
    try {
        const { claimDueAutomations } = require('./automations');
        assert.deepStrictEqual(await claimDueAutomations('worker-1'), []);
    } finally {
        db.pool.connect = connect;
    }
    assert.deepStrictEqual(sent.filter((s) => s === 'COMMIT' || s === 'ROLLBACK'), ['COMMIT']);
});

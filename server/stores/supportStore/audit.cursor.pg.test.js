// @typecheck
/**
 * listAuditEvents pages with a keyset cursor on (created_at, id). The cursor
 * carried the last row's created_at as a JS Date, which holds milliseconds;
 * the column holds microseconds. Compared with the rounded value, every row
 * that shares the cursor row's millisecond sorts ABOVE the cursor and was
 * skipped: an audit page boundary inside one burst silently lost events.
 *
 * Against a real Postgres (@electric-sql/pglite) and the store's own schema.
 *
 * Run: cd server && node --test stores/supportStore/audit.cursor.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { newPglite } = require('../../testUtils/pgliteTemplate');
const { usePglitePool } = require('../../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const audit = require('./audit');

// Five events inside ONE millisecond, plus an older one.
const STAMPS = [
    '2026-03-01 10:00:00.123900+00', '2026-03-01 10:00:00.123700+00', '2026-03-01 10:00:00.123500+00',
    '2026-03-01 10:00:00.123300+00', '2026-03-01 10:00:00.123100+00', '2026-03-01 09:00:00.000000+00',
];

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await audit.listAuditEvents({ organizationId: 'none' }); // the store's own schema init
    for (const [i, at] of STAMPS.entries()) {
        await query(
            `INSERT INTO support_audit_log (organization_id, actor_kind, action, created_at) VALUES ('org1', 'staff', $1, $2)`,
            [`a${i}`, at],
        );
    }
});

after(async () => {
    restorePool();
    await pg.close();
});

async function walk(limit) {
    const seen = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
        const { events, nextCursor } = await audit.listAuditEvents({ organizationId: 'org1', limit, cursor });
        seen.push(...events.map((e) => e.action));
        if (!nextCursor) break;
        cursor = nextCursor;
    }
    return seen;
}

test('paging through events that share a millisecond returns every one, once, newest first', async () => {
    assert.deepStrictEqual(await walk(2), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    assert.deepStrictEqual(await walk(1), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
});

test('a cursor whose row is gone still pages from its timestamp', async () => {
    const gone = Buffer.from(JSON.stringify({ t: '2026-03-01T09:30:00.000Z', id: '00000000-0000-0000-0000-000000000001' })).toString('base64');
    const { events } = await audit.listAuditEvents({ organizationId: 'org1', cursor: gone });
    assert.deepStrictEqual(events.map((e) => e.action), ['a5']);
});

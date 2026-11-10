// @typecheck
/**
 * orgHealthStore.listEvents pages with a keyset cursor on (created_at, id).
 * The cursor carried the last row's created_at as a JS Date (milliseconds);
 * the column holds microseconds. Compared with the rounded value, the rows
 * sharing the cursor row's millisecond sort above the cursor and were skipped,
 * so a burst of connector events lost entries at a page boundary.
 *
 * Against a real Postgres (@electric-sql/pglite) and the store's own schema.
 *
 * Run: cd server && node --test stores/orgHealthStore.cursor.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { newPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const store = require('./orgHealthStore');

// Four events inside ONE millisecond, plus an older one.
const STAMPS = [
    '2026-03-01 10:00:00.456800+00', '2026-03-01 10:00:00.456600+00',
    '2026-03-01 10:00:00.456400+00', '2026-03-01 10:00:00.456200+00', '2026-03-01 08:00:00+00',
];

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await store.initDB();
    for (const [i, at] of STAMPS.entries()) {
        await query(
            `INSERT INTO org_health_events (subject_key, organization_id, code, category, message, created_at)
             VALUES ('org1', 'org1', 'connector.auth_ok', 'connector', $1, $2)`,
            [`e${i}`, at],
        );
    }
});

after(async () => {
    restorePool();
    await pg.close();
});

test('paging through events that share a millisecond returns every one, once, newest first', async () => {
    for (const limit of [1, 2, 3]) {
        const seen = [];
        let cursor = null;
        for (let page = 0; page < 20; page++) {
            const { events, nextCursor } = await store.listEvents({ organizationId: 'org1', limit, cursor });
            seen.push(...events.map((e) => e.message));
            if (!nextCursor) break;
            cursor = nextCursor;
        }
        assert.deepStrictEqual(seen, ['e0', 'e1', 'e2', 'e3', 'e4'], `page size ${limit}`);
    }
});

test('a cursor whose row is gone still pages from its timestamp', async () => {
    const cursor = store._encodeCursor({ created_at: new Date('2026-03-01T09:00:00Z'), id: '00000000-0000-0000-0000-000000000001' });
    const { events } = await store.listEvents({ organizationId: 'org1', cursor });
    assert.deepStrictEqual(events.map((e) => e.message), ['e4']);
});

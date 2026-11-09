// @typecheck
/**
 * The approvals list against a real Postgres (@electric-sql/pglite), behind
 * the real db.js pool.
 *
 *   A. listApprovals pages with a keyset cursor on (created_at, id). The
 *      cursor carried created_at as a JS Date (milliseconds) while the column
 *      holds microseconds; compared with the rounded value, approvals sharing
 *      the cursor row's millisecond were skipped at a page boundary.
 *   B. createApproval ended in `getApprovalForRunStep(...) || getApproval(id)`
 *      without awaiting the first read: a promise is always truthy, so the
 *      fallback never ran and the caller got null for a row that was written
 *      but is no longer pending by the time it is read back.
 *
 * Run: cd server && node --test stores/automationStore/approvals.cursor.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { newPglite } = require('../../testUtils/pgliteTemplate');
const { usePglitePool } = require('../../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const db = require('../../db');
const approvals = require('./approvals');

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await pg.exec(`
        CREATE TABLE automation_approvals (
            id TEXT PRIMARY KEY, organization_id TEXT, owner_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
            prompt TEXT, automation_title TEXT, run_id TEXT, step_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    const rows = [
        ['apr_5', '2026-03-01 10:00:00.321900+00'], ['apr_4', '2026-03-01 10:00:00.321700+00'],
        ['apr_3', '2026-03-01 10:00:00.321500+00'], ['apr_2', '2026-03-01 10:00:00.321300+00'],
        ['apr_1', '2026-03-01 09:00:00+00'],
    ];
    for (const [id, at] of rows) {
        await query(`INSERT INTO automation_approvals (id, organization_id, owner_id, created_at) VALUES ($1, 'org1', 'u1', $2)`, [id, at]);
    }
});

after(async () => {
    restorePool();
    await pg.close();
});

test('A: paging through approvals that share a millisecond returns every one, once, newest first', async () => {
    for (const limit of [1, 2, 3]) {
        const seen = [];
        let cursor = null;
        for (let page = 0; page < 20; page++) {
            const out = await approvals.listApprovals({ org: { orgId: 'org1' }, limit, cursor });
            seen.push(...out.approvals.map((a) => a.id));
            if (!out.nextCursor) break;
            cursor = out.nextCursor;
        }
        assert.deepEqual(seen, ['apr_5', 'apr_4', 'apr_3', 'apr_2', 'apr_1'], `page size ${limit}`);
    }
});

test('B: createApproval hands back the row it wrote when the pending read finds nothing', async () => {
    // The insert and the read by id answer; the pending read for the run step
    // answers no row (decided in between).
    const real = db.pool.query;
    let inserted = null;
    db.pool.query = /** @type {any} */ (async (sql, params) => {
        const text = String(sql);
        if (/^\s*INSERT INTO automation_approvals/.test(text)) { inserted = params[0]; return { rows: [], rowCount: 1 }; }
        if (/status = 'pending'/.test(text)) return { rows: [], rowCount: 0 };
        if (/WHERE id = \$1/.test(text)) return { rows: [{ id: params[0], status: 'approved', owner_id: 'u1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    });
    try {
        const out = await approvals.createApproval({ runId: 'run1', stepId: 's1', ownerId: 'u1' });
        assert.ok(out, 'the fallback read ran');
        assert.equal(out.id, inserted);
        assert.equal(out.status, 'approved');
    } finally {
        db.pool.query = real;
    }
});

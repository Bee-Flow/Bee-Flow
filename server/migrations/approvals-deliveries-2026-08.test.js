// @typecheck
/**
 * The delivery-ledger migration, run on a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js) over a minimal automation_approvals table.
 *
 * Held here because the automation store replays every migration on every
 * boot and core.js only LOGS failures — a non-idempotent statement would fail
 * silently forever after the first boot, leaving the table half-built and
 * every reaction unroutable with no error anyone reads.
 *
 * The three things that must hold:
 *   (a) every statement survives a replay, also over a table an earlier
 *       revision of the file created;
 *   (b) the (roomToken, messageId) index is UNIQUE — it is the routing key,
 *       so two approvals must never be able to claim one Talk message — and
 *       PARTIAL, because a bot-posted card whose id could not be recovered
 *       (POST /bot/{token}/message answers 201 with an empty body) still gets
 *       a row and those rows must not collide on a NULL;
 *   (c) the rows die with the approval they describe.
 *
 * Run: cd server && node --test migrations/approvals-deliveries-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const migration = require('./approvals-deliveries-2026-08');
test.after(close);

test.beforeEach(async () => {
    await pg.exec(`DROP TABLE IF EXISTS automation_approval_deliveries; DROP TABLE IF EXISTS automation_approvals;
        CREATE TABLE automation_approvals (id TEXT PRIMARY KEY);
        INSERT INTO automation_approvals (id) VALUES ('ap1'), ('ap2');`);
});

let seq = 0;
/** @param {Record<string, unknown>} over */
const delivery = (over) => insertRow(pg, 'automation_approval_deliveries', { id: `d${++seq}`, approval_id: 'ap1', channel: 'nc_talk', ...over });

test('every statement survives being replayed on the next boot', async () => {
    await migration.up();
    await migration.up();
    const { rows } = await pg.query("SELECT indexname FROM pg_indexes WHERE tablename = 'automation_approval_deliveries' ORDER BY 1");
    assert.deepEqual(rows.map(r => r.indexname), ['automation_approval_deliveries_pkey', 'idx_appr_deliv_approval', 'uq_appr_deliv_talk_msg']);
});

test('a table from an earlier revision gets the columns it lacks', async () => {
    await pg.exec(`CREATE TABLE automation_approval_deliveries (
        id TEXT PRIMARY KEY, approval_id TEXT NOT NULL REFERENCES automation_approvals(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, external_ref JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await migration.up();
    const row = await delivery({});
    assert.equal(row.status, 'sent');
    for (const col of ['stage', 'organization_id', 'user_id', 'nc_uid', 'error']) assert.ok(col in row, `missing column ${col}`);
});

test('the ledger carries what routing and auditing each need', async () => {
    await migration.up();
    const row = await delivery({
        stage: 'first', organization_id: 'o1', user_id: 'u1', nc_uid: 'kim', error: null,
        // The external id is JSONB: a Talk message and a notification have nothing
        // in common but "an id on someone else's server".
        external_ref: { roomToken: 'r1', messageId: 42 },
    });
    assert.deepEqual(row.external_ref, { roomToken: 'r1', messageId: 42 });
    assert.equal(row.status, 'sent');
    // A card is evidence about an approval and worthless without it.
    await assert.rejects(delivery({ approval_id: 'nope' }), /foreign key/);
    await pg.query("DELETE FROM automation_approvals WHERE id = 'ap1'");
    assert.equal((await pg.query('SELECT 1 FROM automation_approval_deliveries')).rows.length, 0, 'the rows die with their approval');
});

test('the routing key is unique AND partial', async () => {
    await migration.up();
    await delivery({ external_ref: { roomToken: 'r1', messageId: '7' } });
    await assert.rejects(delivery({ approval_id: 'ap2', external_ref: { roomToken: 'r1', messageId: '7' } }), /duplicate key|unique/,
        'two approvals cannot claim one Talk message');
    await delivery({ approval_id: 'ap2', external_ref: { roomToken: 'r2', messageId: '7' } });
    // Partial, so a delivery with no recoverable message id still gets a row.
    await delivery({ external_ref: { roomToken: 'r1' } });
    await delivery({ approval_id: 'ap2', external_ref: { roomToken: 'r1' } });
    // Only Talk messages are routed by it.
    await delivery({ channel: 'nc_notification', external_ref: { roomToken: 'r1', messageId: '7' } });
});

test('the per-approval lookup is indexed — "did the card land?" is a support question', async () => {
    await migration.up();
    const { rows } = await pg.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_appr_deliv_approval'");
    assert.equal(rows.length, 1);
    assert.ok(rows[0].indexdef.endsWith('(approval_id, created_at)'), rows[0].indexdef);
});

test('the migration is registered, and after the table it extends', () => {
    // WAS "registered LAST". That assertion was true when written and became
    // false the moment the next migration was appended — which is inevitable,
    // so it made a permanent failure out of normal progress, and the whole file
    // was excluded from `npm test` to silence it. That took the four real
    // checks above (idempotency, the UNIQUE index, its partial WHERE, the
    // per-approval index) out of CI with it.
    //
    // The invariant actually worth pinning is the one the old name described:
    // an unregistered file never runs, and a migration must not sort ABOVE the
    // table it alters, because the array is applied in order on every boot.
    const core = fs.readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'core.js'), 'utf8');
    const list = core.slice(core.indexOf('const MIGRATIONS = ['), core.indexOf('];', core.indexOf('const MIGRATIONS = [')));
    const names = [...list.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
    const self = names.indexOf('approvals-deliveries-2026-08');
    assert.notEqual(self, -1, 'approvals-deliveries-2026-08 is not listed in MIGRATIONS — it would never run');
    const base = names.indexOf('automation-approvals-2026-08');
    assert.notEqual(base, -1, 'automation-approvals-2026-08 is not listed');
    assert.ok(self > base,
        `approvals-deliveries-2026-08 (#${self}) must run after automation-approvals-2026-08 (#${base}), which creates the tables it extends`);
});

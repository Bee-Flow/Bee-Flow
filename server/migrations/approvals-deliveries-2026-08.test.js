/**
 * The delivery-ledger migration.
 *
 * Pinned here because the automation store replays every migration on every
 * boot and core.js only LOGS failures — a non-idempotent statement would fail
 * silently forever after the first boot, leaving the table half-built and
 * every reaction unroutable with no error anyone reads.
 *
 * The three things that must hold:
 *   (a) every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS;
 *   (b) the (roomToken, messageId) index is UNIQUE — it is the routing key,
 *       so two approvals must never be able to claim one Talk message — and
 *       PARTIAL, because a bot-posted card whose id could not be recovered
 *       (POST /bot/{token}/message answers 201 with an empty body) still gets
 *       a row and those rows must not collide on a NULL;
 *   (c) the rows die with the approval they describe.
 *
 * The pg layer is mocked via require.cache (mirrors
 * automation-run-root-2026-08.test.js).
 *
 * Run: cd server && node --test --test-force-exit migrations/approvals-deliveries-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ddl = [];
const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const fakeDb = {
    async exec(sql) { ddl.push(flat(sql)); },
    async run(sql) { ddl.push(flat(sql)); return { rowCount: 0, rows: [] }; },
    async getOne() { return null; },
};

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const migration = require('./approvals-deliveries-2026-08');

test('every statement survives being replayed on the next boot', async () => {
    ddl.length = 0;
    await migration.up();
    const first = ddl.length;
    await migration.up();
    assert.equal(ddl.length, first * 2, 'ran twice without throwing');
    for (const s of ddl) {
        if (s.startsWith('CREATE TABLE')) assert.match(s, /CREATE TABLE IF NOT EXISTS/);
        if (s.startsWith('CREATE INDEX') || s.startsWith('CREATE UNIQUE INDEX')) {
            assert.match(s, /IF NOT EXISTS/);
        }
        if (s.startsWith('ALTER TABLE')) {
            // Every ADD COLUMN in the statement, not just the first.
            const adds = s.match(/ADD COLUMN[^,;]*/g) || [];
            assert.ok(adds.length > 0);
            for (const a of adds) assert.match(a, /ADD COLUMN IF NOT EXISTS/);
        }
    }
});

test('the ledger carries what routing and auditing each need', async () => {
    ddl.length = 0;
    await migration.up();
    const create = ddl.find(s => s.includes('CREATE TABLE IF NOT EXISTS automation_approval_deliveries'));
    assert.ok(create, 'the table is created');
    for (const col of ['approval_id', 'stage', 'channel', 'organization_id',
        'external_ref', 'user_id', 'nc_uid', 'status', 'error']) {
        assert.ok(create.includes(col), `missing column ${col}`);
    }
    // The external id is JSONB: a Talk message and a notification have nothing
    // in common but "an id on someone else's server".
    assert.match(create, /external_ref\s+JSONB/);
    // A card is evidence about an approval and worthless without it.
    assert.match(create, /REFERENCES automation_approvals\(id\) ON DELETE CASCADE/);
});

test('the routing key is unique AND partial', async () => {
    ddl.length = 0;
    await migration.up();
    const uq = ddl.find(s => s.includes('uq_appr_deliv_talk_msg'));
    assert.ok(uq, 'the (room, message) → approval index exists');
    assert.match(uq, /CREATE UNIQUE INDEX IF NOT EXISTS/);
    assert.match(uq, /external_ref->>'roomToken'/);
    assert.match(uq, /external_ref->>'messageId'/);
    // Partial, so a delivery with no recoverable message id still gets a row.
    assert.match(uq, /WHERE channel = 'nc_talk' AND external_ref->>'messageId' IS NOT NULL/);
});

test('the per-approval lookup is indexed — "did the card land?" is a support question', async () => {
    ddl.length = 0;
    await migration.up();
    assert.ok(ddl.some(s => s.includes('idx_appr_deliv_approval') && s.includes('(approval_id, created_at)')));
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

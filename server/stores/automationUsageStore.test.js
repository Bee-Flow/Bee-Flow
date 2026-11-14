/**
 * automationUsageStore — the index "which button runs this automation" (P4 part C).
 *
 * What is fixed here, in order of how bad it is if it breaks:
 *
 *   1. THE OWNERSHIP LOCK IS IN THE INSERT. An app may only index an automation of the
 *      SAME owner. `automationBridge` refuses when `automation.userId !== app.userId`,
 *      so a reference across that boundary cannot run; indexing it anyway would show the
 *      automation's owner the name of someone else's app. And because the lock sits in the INSERT, a
 *      non-empty list that writes ZERO rows is how that shows itself.
 *   2. THE DELETE IS ON TWO COLUMNS. Delete-then-insert on
 *      `(consumer_kind, consumer_id)` — never on the id alone, because then a
 *      future second kind could wipe the rows of the first.
 *   3. THE automation_id IS IN THE KEY. One action can run two automations
 *      (two run_automation steps in the same sequence). Without the automation id in the PK
 *      the second overwrites the first and one of the two automations sees
 *      itself as unused.
 *   4. SCOPE AND OWNER COME FROM THE AUTOMATION, NOT FROM THE CALLER.
 *      `owner_user_id` and `organization_id` are read from the `automations` row;
 *      otherwise they are two facts that can drift apart.
 *   5. A MISSING studio_apps TABLE GIVES FEWER TITLES, NEVER FEWER ROWS. On a fresh
 *      installation that table only exists once someone opens App
 *      Studio, and a JOIN to a non-existent relation is a 500 on
 *      the capsule.
 *
 * On a real Postgres: PGlite behind db.js's pool (testUtils/pglitePool.js), the
 * store's own DDL through its runDdl ladder, and the two tables it reads from
 * (`automations`, `studio_apps`) as fixtures holding only the columns it reads.
 * `studio_apps` is created after the first test, which is the fresh install.
 *
 * Run: cd server && node --test stores/automationUsageStore.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./automationUsageStore');

before(async () => {
    await pg.exec('CREATE TABLE automations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, organization_id TEXT)');
    await store.initDB();
});
after(close);

async function reset() {
    await pg.exec('DELETE FROM automation_usage; DELETE FROM automation_usage_indexed; DELETE FROM automations');
    if ((await pg.query("SELECT to_regclass('studio_apps') AS t")).rows[0].t) await pg.exec('DELETE FROM studio_apps');
}
/** @param {...{ id: string, user_id: string, organization_id: string | null }} rows */
async function automations(...rows) {
    for (const r of rows) await pg.query('INSERT INTO automations (id, user_id, organization_id) VALUES ($1, $2, $3)', [r.id, r.user_id, r.organization_id]);
}
/** @param {string} id @param {string} name */
const app = (id, name) => pg.query('INSERT INTO studio_apps (id, name) VALUES ($1, $2)', [id, name]);
const usageRows = async () => (await pg.query('SELECT * FROM automation_usage ORDER BY consumer_id, ref_id')).rows;
const markers = async () => (await pg.query('SELECT consumer_kind, consumer_id FROM automation_usage_indexed ORDER BY consumer_id')).rows;

const APP = 'app_1';
const OWNER = 'u_owner';
const ORG = 'org_1';
const RID = 'auto_1';

function automation(id = RID, userId = OWNER, organizationId = ORG) {
    return { id, user_id: userId, organization_id: organizationId };
}

function entry(over = {}) {
    return {
        automationId: RID,
        refId: 'act:act_aaaa',
        screenId: 'scr_home',
        nodeId: 'cmp_btn',
        label: 'Send invoice',
        wired: true,
        ...over,
    };
}

// ── 5 (first: the fresh install has no studio_apps yet) ──────────────

test('without a studio_apps table the rows come back without a title, not without rows', async () => {
    await reset();
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].consumerTitle, null);
    assert.deepEqual(await store.usageIndexCoverage(), { complete: true, pending: 0 });
    assert.deepEqual(await store.listUnindexedApps(10), []);
    // From here on the table exists.
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, name TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
});

// ── 1: the ownership lock ────────────────────────────────────────────

test('an automation of ANOTHER owner is not indexed, and that shows', async () => {
    await reset();
    await automations(automation(RID, 'u_someone_else'));
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(written, 0, 'nothing written');
    assert.deepEqual(await usageRows(), []);
    // And the caller can see it: a non-empty list that writes 0.
    assert.deepEqual(await store.listUsageOfAutomation(RID), []);
});

test('an automation that no longer exists is not indexed', async () => {
    await reset();
    assert.equal(await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]), 0);
});

test('an automation of the same owner is indexed', async () => {
    await reset();
    await automations(automation());
    await app(APP, 'Invoicing');
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(written, 1);
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows.length, 1);
    assert.deepEqual(
        { kind: rows[0].consumerKind, id: rows[0].consumerId, title: rows[0].consumerTitle, action: rows[0].actionId, label: rows[0].label, wired: rows[0].wired },
        { kind: 'app', id: APP, title: 'Invoicing', action: 'act_aaaa', label: 'Send invoice', wired: true },
    );
});

// ── 4: owner and organisation come from the AUTOMATION ───────────────

test('owner_user_id and organization_id come from the automation, not from the caller', async () => {
    await reset();
    await automations(automation(RID, OWNER, 'org_of_the_automation'));
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    const [row] = await usageRows();
    assert.equal(row.owner_user_id, OWNER);
    assert.equal(row.organization_id, 'org_of_the_automation');
    assert.equal((await store.listUsageOfAutomation(RID))[0].organizationId, 'org_of_the_automation');

    // The automation moves organisation: the next reconcile follows it.
    await pg.query('UPDATE automations SET organization_id = $1 WHERE id = $2', ['org_moved', RID]);
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal((await usageRows())[0].organization_id, 'org_moved');
});

// ── 3: the automation id is in the key ───────────────────────────────

test('an action that runs two automations gives two rows, not one overwritten row', async () => {
    await reset();
    await automations(automation('auto_a'), automation('auto_b'));
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: 'auto_a', refId: 'act:act_same' }),
        entry({ automationId: 'auto_b', refId: 'act:act_same' }),
    ]);
    assert.equal(written, 2);
    assert.equal((await store.listUsageOfAutomation('auto_a')).length, 1);
    assert.equal((await store.listUsageOfAutomation('auto_b')).length, 1);
});

// ── 2: delete-then-insert, on TWO columns ────────────────────────────

test('reconcile replaces exactly the rows of this app and leaves other apps alone', async () => {
    await reset();
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ refId: 'act:act_old' })]);
    await store.reconcileAutomationUsage('app', 'app_2', OWNER, [entry({ refId: 'act:act_of_app2' })]);
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ refId: 'act:act_new' })]);

    const refs = (await store.listUsageOfAutomation(RID)).map(r => `${r.consumerId}/${r.refId}`).sort();
    assert.deepEqual(refs, ['app_1/act:act_new', 'app_2/act:act_of_app2'],
        'the old row of app_1 is gone, the one of app_2 is still there');
});

test('an empty list clears the rows of this app — so the reconciler must know what it does', async () => {
    await reset();
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal((await usageRows()).length, 1);
    assert.equal(await store.reconcileAutomationUsage('app', APP, OWNER, []), 0);
    assert.deepEqual(await usageRows(), []);
});

test('a second reconcile with the same key writes no second row but updates it', async () => {
    await reset();
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ label: 'Old' })]);
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ label: 'New', wired: false })]);
    assert.equal((await usageRows()).length, 1);
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows[0].label, 'New');
    assert.equal(rows[0].wired, false);
});

// ── purge, both sides of the missing FK ──────────────────────────────

test('purgeUsageForConsumer removes only the rows of that app', async () => {
    await reset();
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    await store.reconcileAutomationUsage('app', 'app_2', OWNER, [entry()]);
    assert.equal(await store.purgeUsageForConsumer('app', APP), 1);
    assert.deepEqual((await store.listUsageOfAutomation(RID)).map(r => r.consumerId), ['app_2']);
});

test('purgeUsageOfAutomation removes the rows of that automation, across apps', async () => {
    await reset();
    await automations(automation('auto_a'), automation('auto_b'));
    await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: 'auto_a', refId: 'act:a' }),
        entry({ automationId: 'auto_b', refId: 'act:b' }),
    ]);
    await store.reconcileAutomationUsage('app', 'app_2', OWNER, [entry({ automationId: 'auto_a', refId: 'act:a' })]);
    assert.equal(await store.purgeUsageOfAutomation('auto_a'), 2);
    assert.deepEqual(await store.listUsageOfAutomation('auto_a'), []);
    assert.equal((await store.listUsageOfAutomation('auto_b')).length, 1);
});

// ── input hygiene ────────────────────────────────────────────────────

test('an unknown consumerKind throws instead of silently doing nothing', async () => {
    await assert.rejects(() => store.reconcileAutomationUsage('webpage', APP, OWNER, []), /consumerKind/);
    await assert.rejects(() => store.purgeUsageForConsumer('kb', APP), /consumerKind/);
});

test('reconcile without an owner throws — an unlocked INSERT may not exist', async () => {
    await assert.rejects(() => store.reconcileAutomationUsage('app', APP, null, [entry()]), /ownerUserId/);
    await assert.rejects(() => store.reconcileAutomationUsage('app', '', OWNER, [entry()]), /consumerId/);
});

test('entries without an automation id or without a ref are skipped, not written', async () => {
    await reset();
    await automations(automation());
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: '' }),
        entry({ refId: null }),
        null,
        entry(),
    ]);
    assert.equal(written, 1);
    assert.equal((await usageRows()).length, 1);
});

// ── counting ─────────────────────────────────────────────────────────

test('countUsageOfAutomations gives 0 for an automation that is used nowhere', async () => {
    await reset();
    await automations(automation('auto_a'), automation('auto_other'));
    await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: 'auto_a', refId: 'act:1' }),
        entry({ automationId: 'auto_a', refId: 'act:2' }),
        entry({ automationId: 'auto_other', refId: 'act:3' }),
    ]);
    const counts = await store.countUsageOfAutomations(['auto_a', 'auto_empty']);
    assert.equal(counts.get('auto_a'), 2);
    assert.equal(counts.get('auto_empty'), 0);
    assert.equal(counts.has('auto_other'), false, 'only the ids asked for');
    assert.deepEqual(await store.countUsageOfAutomations([]), new Map());
});

// ── the ladder ───────────────────────────────────────────────────────

test('the table keys on (consumer_kind, consumer_id, ref_id, automation_id); the marker on the consumer', async () => {
    const pk = async (table) => (await pg.query(`
        SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [table])).rows.map(r => r.attname);
    assert.deepEqual(await pk('automation_usage'), ['consumer_kind', 'consumer_id', 'ref_id', 'automation_id']);
    assert.deepEqual(await pk('automation_usage_indexed'), ['consumer_kind', 'consumer_id']);
    const { rows } = await pg.query("SELECT indexname FROM pg_indexes WHERE tablename = 'automation_usage' ORDER BY indexname");
    for (const name of ['idx_automation_usage_automation', 'idx_automation_usage_consumer']) {
        assert.ok(rows.some(r => r.indexname === name), name);
    }
});

// ── the third answer: "never looked at" ──────────────────────────────
//
// `automation_usage` can only show rows, and zero rows there means two
// things at once: "no button at all runs this automation" and "this index has
// never been built for that app yet". On the day of rollout the second is true for
// EVERY existing app — the table is created empty and only fills when
// someone saves an app — and then every automation owner reads "used nowhere"
// about buttons that do run.

test('a reconcile marks the app as looked at — also one that switches nothing on', async () => {
    await reset();
    await app(APP, 'Expenses');
    assert.deepEqual(await store.usageIndexCoverage(), { complete: false, pending: 1 });

    // An EMPTY list is a valid outcome: this app really switches nothing on.
    await store.reconcileAutomationUsage('app', APP, OWNER, []);
    assert.deepEqual(await store.usageIndexCoverage(), { complete: true, pending: 0 });
    assert.deepEqual(await store.listUnindexedApps(10), []);
});

test('the marker is written together with the rows', async () => {
    await reset();
    await app(APP, 'Expenses');
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.deepEqual(await markers(), [{ consumer_kind: 'app', consumer_id: APP }]);
    assert.equal((await usageRows()).length, 1);
});

test('an app that was never looked at is on the work list of the backfill', async () => {
    await reset();
    await app('app_a', 'A');
    await app('app_b', 'B');
    await store.reconcileAutomationUsage('app', 'app_a', OWNER, []);
    assert.deepEqual(await store.listUnindexedApps(10), ['app_b']);
    assert.deepEqual(await store.usageIndexCoverage(), { complete: false, pending: 1 });
});

test('a deleted app also loses its marker — it was not looked at, it is not there', async () => {
    await reset();
    await app(APP, 'Expenses');
    await automations(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    await store.reconcileAutomationUsage('app', 'app_2', OWNER, []);
    assert.equal((await store.usageIndexCoverage()).pending, 0);
    await store.purgeUsageForConsumer('app', APP);
    assert.deepEqual(await markers(), [{ consumer_kind: 'app', consumer_id: 'app_2' }], 'the marker goes with it, the other app keeps its own');
});

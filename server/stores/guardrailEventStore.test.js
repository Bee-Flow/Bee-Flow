// @typecheck
/**
 * The guardrail events ledger against a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js).
 *
 * Pins: getRecentGuardrailEvents honours filters.userId (the only scope an
 * org-less consumer account has) and clamps its limit; category aggregation
 * reads BOTH the legacy "a, b" encoding and the canonical "a,b"; the dry-run
 * filter; pii_messages counts only events whose categories name a find; and
 * the schema init is single-flight and idempotent.
 *
 * Run: cd server && node --test stores/guardrailEventStore.test.js
 */

'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./guardrailEventStore');

/** @param {Record<string, unknown>} row */
async function event(row) {
    const cols = Object.keys(row);
    await pg.query(
        `INSERT INTO guardrail_events (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
    );
}

before(async () => {
    // Two callers at once on a cold store: the DDL runs once and both succeed.
    await Promise.all([store.getGuardrailSummary({}), store.getGuardrailByAction({})]);
});
after(close);

test('the schema is in place after init: the live-rows index, and the redundant org index dropped', async () => {
    const idx = (await pg.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'guardrail_events'")).rows;
    const live = idx.find((r) => r.indexname === 'idx_guardrail_org_ts_live');
    assert.ok(live && /WHERE \(is_dry_run = false\)/.test(live.indexdef));
    assert.ok(!idx.some((r) => r.indexname === 'idx_guardrail_org'));
    const cols = (await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'guardrail_events'")).rows.map((r) => r.column_name);
    for (const c of ['automation_id', 'run_id', 'step_id', 'is_dry_run', 'attachment_filename']) assert.ok(cols.includes(c), c);
});

test('the dry-run filter leaves out dry-run rows', async () => {
    await event({ organization_id: 'o-dry', violation_type: 'pii', is_dry_run: true });
    await event({ organization_id: 'o-dry', violation_type: 'pii', is_dry_run: false });
    assert.strictEqual(Number((await store.getGuardrailSummary({ organizationId: 'o-dry', excludeDryRun: true })).total_events), 1);
    assert.strictEqual(Number((await store.getGuardrailSummary({ organizationId: 'o-dry' })).total_events), 2);
});

test('getRecentGuardrailEvents honours userId (consumer leak regression)', async () => {
    await event({ user_id: 'consumer-9', violation_type: 'pii' });
    await event({ user_id: 'someone-else', violation_type: 'pii' });
    const rows = await store.getRecentGuardrailEvents(10, { userId: 'consumer-9' });
    assert.deepStrictEqual(rows.map((r) => r.user_id), ['consumer-9']);
});

test('getRecentGuardrailEvents clamps the limit at 200', async () => {
    await pg.query(`INSERT INTO guardrail_events (organization_id, violation_type) SELECT 'o-many', 'pii' FROM generate_series(1, 205)`);
    assert.strictEqual((await store.getRecentGuardrailEvents(99999, { organizationId: 'o-many' })).length, 200);
    assert.strictEqual((await store.getRecentGuardrailEvents(3, { organizationId: 'o-many' })).length, 3);
});

test('category aggregation reads the legacy "a, b" and the canonical "a,b" alike', async () => {
    await event({ organization_id: 'o-cat', violation_type: 'pii', violation_categories: 'email, phone' });
    await event({ organization_id: 'o-cat', violation_type: 'pii', violation_categories: 'email,iban' });
    const rows = await store.getGuardrailByCategory({ organizationId: 'o-cat' });
    const counts = Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
    assert.deepStrictEqual(counts, { email: 2, phone: 1, iban: 1 });
});

test('summary: pii_messages counts only events whose categories name a find', async () => {
    const org = 'o-sum';
    await event({ organization_id: org, violation_type: 'pii', violation_categories: 'email' });
    await event({ organization_id: org, violation_type: 'pii', violation_categories: 'phone, token_evicted' });
    // Not a find: only markers, an audit or note type, a check that could not run, no categories.
    await event({ organization_id: org, violation_type: 'pii', violation_categories: 'token_evicted, privacy_protection_unavailable' });
    for (const type of ['admin_action', 'user_action', 'unicode_smuggling', 'pii_tokenmap', 'scan_failed', 'pii_unavailable']) {
        await event({ organization_id: org, violation_type: type, violation_categories: 'email' });
    }
    await event({ organization_id: org, violation_type: 'pii', violation_categories: 'email', action_taken: 'scan_failed' });
    await event({ organization_id: org, violation_type: 'pii' });
    const s = await store.getGuardrailSummary({ organizationId: org });
    assert.strictEqual(Number(s.pii_messages), 2);
    assert.strictEqual(Number(s.total_events), 11);
});

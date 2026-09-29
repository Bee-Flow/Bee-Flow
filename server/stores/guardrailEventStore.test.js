/**
 * Store-level tests — guardrail events ledger.
 *
 * Pins: (1) getRecentGuardrailEvents honors filters.userId — the consumer
 * (org-less) cross-tenant leak; (2) category aggregation splits on ',' + trim
 * so it reads BOTH the legacy "a, b" encoding and the canonical "a,b";
 * (3) buildFilters knows excludeDryRun; (4) initDB is single-flight with a
 * warm-boot probe.
 *
 * Hermetic: ../db is stubbed; no Postgres.
 *
 * Run: node --test server/stores/guardrailEventStore.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

const dbCalls = { exec: [], run: [], getOne: [], getAll: [] };
let probeResult = null;

const dbStub = {
    async exec(sql) { dbCalls.exec.push(sql); return { rowCount: 0 }; },
    async run(sql, params) { dbCalls.run.push({ sql, params }); return { rowCount: 1 }; },
    async getOne(sql, params) {
        dbCalls.getOne.push({ sql, params });
        if (/pg_indexes/.test(sql)) return probeResult;
        return null;
    },
    async getAll(sql, params) { dbCalls.getAll.push({ sql, params }); return []; },
};

const STORES_DIR = path.sep + 'stores' + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(STORES_DIR) && request === '../db') {
        return path.join(__dirname, '__stub_db_guardev__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
{
    const full = path.join(__dirname, '__stub_db_guardev__.js');
    require.cache[full] = { id: full, filename: full, loaded: true, exports: dbStub };
}

const store = require('./guardrailEventStore');
const flatSql = (s) => s.replace(/\s+/g, ' ');

test('initDB runs the DDL exactly once (single-flight, cold boot)', async () => {
    await Promise.all([store.getGuardrailSummary({}), store.getGuardrailByAction({})]);
    const creates = dbCalls.exec.filter(s => /CREATE TABLE/.test(s)).length;
    assert.strictEqual(creates, 1);
    const alters = dbCalls.exec.filter(s => /ALTER TABLE guardrail_events/.test(s)).length;
    assert.strictEqual(alters, 1, 'the column ladder must be one consolidated ALTER');
    const all = dbCalls.exec.join('\n');
    assert.match(all, /idx_guardrail_org_ts_live.*WHERE is_dry_run = false/s);
    assert.match(all, /DROP INDEX IF EXISTS idx_guardrail_org\b/);
});

test('buildFilters supports excludeDryRun', () => {
    const { where } = store.buildFilters({ organizationId: 'o', excludeDryRun: true });
    assert.match(flatSql(where), /is_dry_run = false/);
});

test('getRecentGuardrailEvents honors userId (consumer leak regression)', async () => {
    dbCalls.getAll.length = 0;
    await store.getRecentGuardrailEvents(10, { userId: 'consumer-9' });
    const call = dbCalls.getAll.at(-1);
    assert.match(flatSql(call.sql), /user_id = \$\d/);
    assert.ok(call.params.includes('consumer-9'));
    assert.ok(!/SELECT \*/.test(call.sql), 'recent events must use an explicit column list');
    assert.strictEqual(call.params.at(-1), 10);
});

test('getRecentGuardrailEvents clamps the limit', async () => {
    dbCalls.getAll.length = 0;
    await store.getRecentGuardrailEvents(99999, {});
    assert.strictEqual(dbCalls.getAll.at(-1).params.at(-1), 200);
});

test('category aggregation splits on comma + trim (legacy AND canonical encodings)', async () => {
    dbCalls.getAll.length = 0;
    await store.getGuardrailByCategory({ organizationId: 'o' });
    const sql = flatSql(dbCalls.getAll.at(-1).sql);
    assert.match(sql, /string_to_array\(violation_categories, ','\)/, "split on ',' — trim absorbs the legacy ', '");
    assert.match(sql, /trim\(cat\)/);
    assert.ok(!/string_to_array\(violation_categories, ', '\)/.test(sql), "splitting on ', ' would glue canonical rows together");
});

test('summary: pii_messages counts only events whose categories name a find', async () => {
    dbCalls.getOne.length = 0;
    await store.getGuardrailSummary({ organizationId: 'o' });
    const sql = flatSql(dbCalls.getOne.at(-1).sql);
    const clause = /COUNT\(\*\) FILTER \(WHERE EXISTS[\s\S]*?as pii_messages/.exec(sql);
    assert.ok(clause, 'pii_messages is in the summary');
    // A row whose only categories are markers (a routine hitting the placeholder cap) names no find.
    assert.match(clause[0], /trim\(c\) NOT IN \([^)]*'token_evicted'[^)]*'privacy_protection_unavailable'|trim\(c\) NOT IN \([^)]*'privacy_protection_unavailable'[^)]*'token_evicted'/);
    // Not the audit, not a note, not a check that could not run.
    for (const type of ['admin_action', 'user_action', 'unicode_smuggling', 'pii_tokenmap', 'scan_failed', 'pii_unavailable']) {
        assert.ok(clause[0].includes(`'${type}'`), type);
    }
    assert.match(clause[0], /action_taken IS DISTINCT FROM 'scan_failed'/);
    assert.match(clause[0], /string_to_array\(COALESCE\(violation_categories, ''\), ','\)/);
});

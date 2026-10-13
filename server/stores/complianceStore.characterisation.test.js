'use strict';

/**
 * complianceStore — the golden behaviour, pinned before the store was split
 * into stores/compliance/ (schema, settings, checks, evidence, findings)
 * behind the complianceStore barrel.
 *
 * '../db' and the evidence chain are swapped for recording doubles BEFORE the
 * barrel is required. Every statement the store sends — through run / getOne /
 * getAll / exec and the transaction client — lands in ONE ordered trace
 * (normalised SQL + params), and each public function's return value is
 * recorded next to it. The whole trace is compared with
 * complianceStore.characterisation.golden.json: a pure move must leave the
 * boot DDL order, every statement, every bind and every answer exactly as is.
 * The export surface (keys and their types) is pinned as well.
 *
 * Regenerate (only for a deliberate behaviour change):
 *   UPDATE_GOLDEN=1 node --test stores/complianceStore.characterisation.test.js
 *
 * Run: cd server && node --test stores/complianceStore.characterisation.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

const GOLDEN = path.join(__dirname, 'complianceStore.characterisation.golden.json');

const chainStub = {
    hashPayload: (payload) => `P(${JSON.stringify(payload)})`,
    linkHash: (prev, payloadHash) => `L(${prev === null ? '0' : prev}|${payloadHash})`,
};

const TRACE = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// Canned answers per statement shape, so every read path has rows to shape.
const STORED_SETTINGS = {
    organization_id: 'orgA', dpo_name: 'Dana', dpo_email: null, legal_bases: '["contract"]',
    data_residency: 'eu', breach_recipients: null, framework_relevance: 'not json',
    enabled_frameworks: ['gdpr'], scc_confirmed_operators: [{ operator: 'OpenAI', contract_ref: 'C-1' }],
    memory_retention_enabled: true, default_retention_days: 30,
};
let settingsRow = null;
let evidenceHead = null;
function answer(sql) {
    if (/^SELECT \* FROM compliance_settings/i.test(sql)) return { rows: settingsRow ? [{ ...settingsRow }] : [], rowCount: settingsRow ? 1 : 0 };
    if (/FROM compliance_score_history/i.test(sql)) {
        return { rows: [
            { overall_score: 80, gdpr_score: 70, aia_score: 90, iso_score: null, pass: 1, warn: 2, fail: 0, na: 0, run_type: 'manual', captured_at: '2026-10-01T00:00:00.000Z', scores: {}, coverage: '{"examined":3}' },
            { overall_score: 81, gdpr_score: 71, aia_score: 91, iso_score: 50, pass: 1, warn: 1, fail: 1, na: 0, run_type: 'scheduled', captured_at: '2026-10-02T00:00:00.000Z', scores: '{"gdpr":71,"nis2":40}', coverage: null },
        ], rowCount: 2 };
    }
    if (/SELECT seq, hash FROM compliance_evidence/i.test(sql)) return { rows: evidenceHead ? [{ ...evidenceHead }] : [], rowCount: evidenceHead ? 1 : 0 };
    if (/^INSERT INTO compliance_evidence/i.test(sql)) return { rows: [{ id: 7, seq: evidenceHead ? String(Number(evidenceHead.seq) + 1) : null, hash: 'H' }], rowCount: 1 };
    if (/COUNT\(\*\)::int AS n FROM compliance_evidence/i.test(sql)) return { rows: [{ n: '4' }], rowCount: 1 };
    if (/FROM compliance_evidence/i.test(sql)) return { rows: [{ id: 3, check_id: 'GDPR-x' }], rowCount: 1 };
    if (/^INSERT INTO compliance_notify_log/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM compliance_notify_log/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/compliance_finding_states/i.test(sql) && /^(INSERT|SELECT)/i.test(sql)) {
        return { rows: [{ check_id: 'C-1', scope_key: 'global', fingerprint: 'fp', state: 'snoozed', reason: undefined, until: '2026-11-01T00:00:00Z', actor_id: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }], rowCount: 1 };
    }
    if (/^DELETE FROM compliance_finding_states/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/compliance_subject_registrations/i.test(sql) && /^(INSERT|SELECT)/i.test(sql)) {
        return { rows: [{ subject_kind: 'project', subject_id: 'p1', purpose: 'x', lawful_basis: null, retention_days: '30', confirmed_by: 'u1', confirmed_at: '2026-10-01T00:00:00Z' }], rowCount: 1 };
    }
    if (/^DELETE FROM compliance_subject_registrations/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM project_hint_dismissals/i.test(sql) && /^SELECT/i.test(sql)) {
        return { rows: [{ hint_key: 'h1', fingerprint: null, snoozed_until: '2026-12-01T00:00:00Z', dismissed_at: null }], rowCount: 1 };
    }
    if (/^DELETE FROM project_hint_dismissals d/i.test(sql)) {
        const e = new Error('relation "projects" does not exist'); e.code = '42P01'; throw e;
    }
    if (/^DELETE FROM project_hint_dismissals/i.test(sql)) return { rows: [], rowCount: 2 };
    if (/FROM compliance_checks/i.test(sql)) return { rows: [{ check_id: 'C-1', status: 'pass' }], rowCount: 1 };
    return undefined;
}

const mock = createRecordingDb({ onQuery: (sql) => answer(sql) });
const rec = (via) => (sql, params) => TRACE.push({ via, sql: norm(sql), params: params === undefined ? null : params });
const db = {
    ...mock.db,
    run: async (sql, params) => { rec('run')(sql, params); return mock.db.run(sql, params); },
    getOne: async (sql, params) => { rec('getOne')(sql, params); return mock.db.getOne(sql, params); },
    getAll: async (sql, params) => { rec('getAll')(sql, params); return mock.db.getAll(sql, params); },
    exec: async (sql) => { rec('exec')(sql); return mock.db.exec(sql); },
    withTransaction: (fn) => mock.db.withTransaction((client) => fn({
        ...client,
        query: async (sql, params) => { rec('client')(sql, params); return client.query(sql, params); },
    })),
};
// The boot DDL goes through stores/lib/_ddl.js (runDdl), which takes its own
// transaction on its own db; record its batches through a stub as well.
const ddlStub = {
    runDdl: async (tag, statements) => {
        TRACE.push({ via: 'runDdl', tag, statements: statements.map(s => norm(typeof s === 'string' ? s : s.sql)) });
        return { failures: [], tolerated: [] };
    },
};

const restore = installResolveStub({
    '../db': db,
    '../compliance/evidence/chain': chainStub,
    './lib/_ddl': ddlStub,
});
const store = require('./complianceStore');
after(() => restore());

async function step(name, fn) {
    TRACE.push({ step: name });
    try {
        const out = await fn();
        TRACE.push({ result: out === undefined ? '<undefined>' : JSON.parse(JSON.stringify(out)) });
    } catch (e) {
        TRACE.push({ threw: { name: e.name, message: e.message, code: e.code ?? null, status: e.status ?? null, body: e.body ?? null } });
    }
}

test('the export surface: keys and their types', () => {
    const surface = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, Array.isArray(v) ? 'array' : typeof v]));
    TRACE.push({ step: 'exports', surface });
});

test('golden trace of every public path', async () => {
    await step('initDB', () => store.initDB());
    await step('initDB again (memoised)', () => store.initDB());

    // ── settings ──
    TRACE.push({ step: 'constants', SETTINGS_FIELDS: store.SETTINGS_FIELDS, SETTINGS_REQUEST_DENY: store.SETTINGS_REQUEST_DENY, FINDING_STATES: store.FINDING_STATES });
    await step('getSettings (no row)', () => store.getSettings('orgA'));
    await step('getSettings (no org)', () => store.getSettings(undefined));
    settingsRow = STORED_SETTINGS;
    await step('getSettings (row)', () => store.getSettings('orgA'));
    await step('saveSettings (update)', () => store.saveSettings('orgA', { dpo_name: null, nis2_entity_class: 'essential', enabled_frameworks: null, unknown_key: 1 }));
    settingsRow = null;
    await step('saveSettings (insert)', () => store.saveSettings('orgB', { legal_bases: ['consent'], support_end_date: '2030-01-01' }));
    await step('saveSettings (null patch)', () => store.saveSettings('orgB', null));
    await step('sanitizeSettingsPatch ok', () => store.sanitizeSettingsPatch({
        dpo_name: 42, legal_bases: ['a'], datatable_review_days: ' 90 ', memory_retention_enabled: 'true',
        onboarded_at: '2026-01-02T03:04:05Z', support_end_date: '2029-02-28', framework_relevance: {},
        enabled_frameworks: ['nis2'], chat_monitoring_enabled: true, dpo_email: undefined, dpo_phone: null, nope: 1,
    }));
    await step('sanitizeSettingsPatch bad', () => store.sanitizeSettingsPatch({
        legal_bases: '[]', datatable_review_days: 5, dora_customer_notice_hours: 99999999999, memory_retention_enabled: 'yes',
        onboarded_at: '0000-01-01', support_end_date: '2029-02-31', dpo_name: `a${String.fromCharCode(0)}b`,
        breach_recipients: Array.from({ length: 22 }).reduce((acc) => [acc], 'deep'), incident_customer_contacts: [{ [`k${String.fromCharCode(0)}`]: 1 }],
        nis2_registered_at: 'later', privacy_notice_url: {}, sso_enforces_mfa: 1, notice_period_days: 1.5,
    }));
    await step('sanitizeSettingsPatch non-object', () => store.sanitizeSettingsPatch('x'));
    await step('SettingsValidationError', () => {
        const e = new store.SettingsValidationError([{ field: 'a', expected: 'b' }]);
        return { name: e.name, message: e.message, code: e.code, status: e.status, body: e.body, isError: e instanceof Error };
    });
    await step('markOnboarded', () => store.markOnboarded('orgA'));
    settingsRow = STORED_SETTINGS;
    const realNow = Date.prototype.toISOString;
    const fixed = '2026-10-13T00:00:00.000Z';
    // attested_at is new Date().toISOString(): pin the clock for that call only.
    const RealDate = global.Date;
    global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } };
    try {
        await step('setSccConfirmed (re-confirm keeps fields)', () => store.setSccConfirmed('orgA', 'openai', true, 'u1'));
        await step('setSccConfirmed (remove)', () => store.setSccConfirmed('orgA', 'OPENAI', false));
    } finally { global.Date = RealDate; }
    assert.strictEqual(Date.prototype.toISOString, realNow);
    settingsRow = null;
    await step('markRopaReviewed', () => store.markRopaReviewed('orgA'));
    await step('markRetentionRun', () => store.markRetentionRun('orgA'));

    // ── checks + score history ──
    await step('recordCheckResult', () => store.recordCheckResult({ check_id: 'C-1', regulation: 'GDPR', status: 'warn' }));
    await step('recordCheckResult full', () => store.recordCheckResult({ organization_id: 'orgA', check_id: 'C-2', regulation: 'CUSTOM', article: 'a', severity: 'high', status: 'fail', evidence: { x: 1 }, details: 'd', scope_type: 'per-source', scope_id: 's', run_type: 'manual', framework_code: 'F' }));
    await step('getLatestPerCheck', () => store.getLatestPerCheck('orgA'));
    await step('listLatestScopes', () => store.listLatestScopes('orgA', 'C-1'));
    await step('getLatestForChecks empty', () => store.getLatestForChecks('orgA', []));
    await step('getLatestForChecks', () => store.getLatestForChecks('orgA', ['C-1', '', 2], { maxAgeDays: 7.9 }));
    await step('getLatestForChecks default age', () => store.getLatestForChecks('orgA', 'C-1'));
    await step('getCheckHistory', () => store.getCheckHistory('orgA', 'C-1'));
    await step('getCheckHistory scoped', () => store.getCheckHistory('orgA', 'C-1', 5, { scopeId: 'project:a' }));
    await step('recordScoreSnapshot legacy', () => store.recordScoreSnapshot({ overall_score: 70, gdpr_score: 60, pass: 1 }));
    await step('recordScoreSnapshot scores', () => store.recordScoreSnapshot({ organization_id: 'orgA', scores: '{"gdpr":50,"nis2":10}', aia_score: 30, coverage: { examined: 2 }, run_type: 'manual' }));
    await step('getScoreHistory', () => store.getScoreHistory('orgA'));
    await step('getScoreHistory days', () => store.getScoreHistory('orgA', 7));

    // ── evidence ──
    await step('addEvidence (no org)', () => store.addEvidence({ check_id: 'C', hash: 'filehash', payload: { a: 1 } }));
    evidenceHead = null;
    await step('addEvidence (genesis)', () => store.addEvidence({ organization_id: 'orgA', subject_type: 't', subject_id: 's', storage_key: 'k', hash: 'h', payload: { sha256: 'own' } }));
    evidenceHead = { seq: '4', hash: 'HEAD' };
    await step('addEvidence (chained)', () => store.addEvidence({ organization_id: 'orgA', payload: { n: 2 } }));
    await step('getChainHead', () => store.getChainHead('orgA'));
    evidenceHead = null;
    await step('getChainHead empty', () => store.getChainHead('orgA'));
    await step('listEvidence', () => store.listEvidence('orgA'));
    await step('listEvidence filtered', () => store.listEvidence('orgA', { checkId: 'C', subjectType: 't', subjectId: 5, regulation: 'DATA_ACT%x', limit: 5000, offset: -3 }));
    await step('countEvidence', () => store.countEvidence('orgA', { regulation: 'GDPR' }));
    await step('countEvidence no filters', () => store.countEvidence('orgA'));
    await step('getEvidenceById', () => store.getEvidenceById('orgA', '3'));
    await step('getEvidenceHistory', () => store.getEvidenceHistory('orgA', 'C', 10));

    // ── notifier, finding states, registrations, hints ──
    await step('markNotified', () => store.markNotified('orgA', 'dsr', 12, '7d'));
    await step('wasNotified', () => store.wasNotified('orgA', 'dsr', 12, '7d'));
    await step('listFindingStates', () => store.listFindingStates('orgA'));
    await step('setFindingState', () => store.setFindingState('orgA', { checkId: 'C-1', scopeKey: 'global', fingerprint: 'fp', state: 'snoozed', until: '2026-11-01' }));
    await step('setFindingState bad', () => store.setFindingState('orgA', { checkId: 'C-1', scopeKey: 'g', fingerprint: 'f', state: 'ignored' }));
    await step('clearFindingState', () => store.clearFindingState('orgA', 'C-1', 'global'));
    await step('listSubjectRegistrations', () => store.listSubjectRegistrations('orgA', 'project'));
    await step('upsertSubjectRegistration', () => store.upsertSubjectRegistration('orgA', { subjectKind: 'project', subjectId: 'p1', purpose: 'x', retentionDays: 30 }));
    await step('deleteSubjectRegistration', () => store.deleteSubjectRegistration('orgA', 'project', 'p1'));
    await step('getHintDismissals', () => store.getHintDismissals('u1', 'p1'));
    await step('recordHintDismissal', () => store.recordHintDismissal('u1', 'p1', 'h1', { fingerprint: 'fp' }));
    await step('recordHintDismissal snooze', () => store.recordHintDismissal('u1', 'p1', 'h1', { snoozedUntil: '2026-12-01' }));
    await step('eraseHintDismissals none', () => store.eraseHintDismissals(''));
    await step('eraseHintDismissals', () => store.eraseHintDismissals(9));
    await step('pruneHintDismissals (missing table)', () => store.pruneHintDismissals());

    const actual = JSON.parse(JSON.stringify(TRACE));
    if (process.env.UPDATE_GOLDEN) {
        fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
        return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.strictEqual(actual.length, golden.length, 'same number of trace entries');
    for (let i = 0; i < golden.length; i++) assert.deepStrictEqual(actual[i], golden[i], `trace entry ${i}`);
});

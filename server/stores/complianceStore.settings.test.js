/**
 * complianceStore — settings persistence.
 *
 * The first block is a CHARACTERISATION test: it pins the merge semantics the
 * hand-written 12-field saveSettings had before it became table-driven, so the
 * refactor can be proven behaviour-preserving rather than argued. The rules it
 * pins, per legacy column:
 *
 *   - a field ABSENT from the patch keeps the stored value;
 *   - an explicit `null` in the patch ALSO keeps the stored value (`??`
 *     fall-through — the legacy UPDATE could never clear a column);
 *   - jsonb columns are serialised with JSON.stringify and cast `::jsonb`;
 *   - `data_residency` falls back to 'eu', the jsonb lists to `[]`, everything
 *     else to null when neither patch nor row carries a value;
 *   - the INSERT path (no row yet) applies exactly the same values;
 *   - unknown keys never reach SQL;
 *   - updated_at is stamped NOW() on every UPDATE.
 *
 * The assertions read the SET / VALUES clause back into a {column: value} map
 * instead of pinning parameter positions, so the same test holds for the
 * hand-written statement and for the generated one.
 *
 * The later blocks cover what the table-driven store adds: the framework and
 * regulation columns of the redesign, jsonb parsing on read, and the
 * compliance_notify_log tier log.
 *
 * Run: cd server && node --test --test-force-exit stores/complianceStore.settings.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');

// Build spec 2.6: the chat signals settings, in SETTINGS_FIELDS order.
const CHAT_MONITORING_COLUMNS = [
    'chat_monitoring_enabled', 'chat_monitoring_surfaces', 'chat_monitoring_signals',
    'chat_monitoring_effective_from', 'chat_monitoring_retention_days', 'chat_monitoring_legal_basis',
    'chat_monitoring_lia_at', 'chat_monitoring_works_council', 'chat_monitoring_works_council_reason',
    'chat_monitoring_works_council_at', 'chat_monitoring_works_council_scope', 'chat_monitoring_dpia_ref',
    'chat_monitoring_dpia_at', 'chat_monitoring_dpia_risk_level', 'chat_monitoring_dpo_advice_at',
    'chat_monitoring_prior_consultation_at', 'chat_monitoring_notice_url', 'chat_monitoring_notice_published_at',
    'chat_monitoring_enabled_at', 'chat_monitoring_enabled_by',
];
const { installResolveStub } = require('../testUtils/stubRequire');

const settingsRows = [];
const notifyRows = [];
const mock = createRecordingDb({
    tables: { compliance_settings: settingsRows, compliance_notify_log: notifyRows },
    onQuery(sql, params) {
        // ON CONFLICT DO NOTHING → rowCount 1 on a fresh key, 0 on a repeat.
        if (/^INSERT INTO compliance_notify_log/i.test(sql)) {
            const [org, kind, id, offset] = params;
            const dup = notifyRows.some(r => r.organization_id === org && r.subject_kind === kind
                && r.subject_id === id && r.offset_key === offset);
            if (dup) return { rows: [], rowCount: 0 };
            notifyRows.push({ organization_id: org, subject_kind: kind, subject_id: id, offset_key: offset });
            return { rows: [], rowCount: 1 };
        }
        return undefined;
    },
});
const restore = installResolveStub({ '../db': mock.db });
const store = require('./complianceStore');

// The boot DDL is captured once: beforeEach() resets the recorder.
let bootDdl = '';
before(async () => {
    await store.initDB();
    bootDdl = [...mock.calls.exec.map(c => c.sql), ...mock.calls.client.map(c => c.sql)].join('\n');
});
after(() => restore());
beforeEach(() => {
    settingsRows.length = 0;
    notifyRows.length = 0;
    mock.reset();
});

// ── SQL → {column: value} readers ────────────────────────────────────────
// `existing` resolves `COALESCE($n, col)` the way Postgres would.
function readUpdate(call, existing = {}) {
    const set = call.sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i);
    assert.ok(set, 'UPDATE has a SET … WHERE clause');
    const out = {};
    const re = /([a-z0-9_]+)\s*=\s*(?:COALESCE\(\$(\d+),\s*[a-z0-9_]+\)|\$(\d+)(?:::jsonb)?|(NOW\(\)))/gi;
    for (const m of set[1].matchAll(re)) {
        const col = m[1];
        if (m[2]) out[col] = call.params[Number(m[2]) - 1] ?? existing[col] ?? null;
        else if (m[3]) out[col] = call.params[Number(m[3]) - 1];
        else out[col] = 'NOW()';
    }
    return out;
}

function readInsert(call) {
    const m = call.sql.match(/INSERT INTO compliance_settings\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i);
    assert.ok(m, 'INSERT has a column list and a VALUES list');
    const cols = m[1].split(',').map(s => s.trim());
    const vals = m[2].split(',').map(s => s.trim());
    assert.strictEqual(cols.length, vals.length, 'column list and VALUES list have the same arity');
    const out = {};
    cols.forEach((col, i) => {
        const p = vals[i].match(/^\$(\d+)/);
        out[col] = p ? call.params[Number(p[1]) - 1] : vals[i];
    });
    return out;
}

function lastUpdate() {
    const c = mock.mutations().filter(q => /^UPDATE compliance_settings/i.test(q.sql.trim())).pop();
    assert.ok(c, 'an UPDATE compliance_settings was issued');
    return c;
}
function lastInsert() {
    const c = mock.mutations().filter(q => /^INSERT INTO compliance_settings/i.test(q.sql.trim())).pop();
    assert.ok(c, 'an INSERT INTO compliance_settings was issued');
    return c;
}

const LEGACY_ROW = {
    organization_id: 'orgA',
    dpo_name: 'Dana', dpo_email: 'dpo@example.test', dpo_phone: '+31 6 000',
    legal_bases: ['contract'], data_residency: 'hybrid',
    breach_recipients: ['sec@example.test'], default_retention_days: 365,
    privacy_notice_url: 'https://example.test/privacy',
    onboarded_at: '2026-01-01T00:00:00.000Z',
    ai_literacy_confirmed_at: '2026-02-01T00:00:00.000Z',
    ai_literacy_material_url: 'https://example.test/ai-literacy',
    scc_confirmed_operators: [], ropa_reviewed_at: null, ropa_reviewed_by: null,
    last_retention_run_at: null,
};

// ── Characterisation: the 12 legacy fields ───────────────────────────────

test('legacy: a field absent from the patch keeps the stored value (UPDATE path)', async () => {
    settingsRows.push({ ...LEGACY_ROW });
    await store.saveSettings('orgA', { dpo_name: 'Nieuw' });
    const set = readUpdate(lastUpdate(), LEGACY_ROW);
    assert.strictEqual(set.dpo_name, 'Nieuw');
    assert.strictEqual(set.dpo_email, LEGACY_ROW.dpo_email);
    assert.strictEqual(set.dpo_phone, LEGACY_ROW.dpo_phone);
    assert.strictEqual(set.data_residency, 'hybrid');
    assert.strictEqual(set.default_retention_days, 365);
    assert.strictEqual(set.privacy_notice_url, LEGACY_ROW.privacy_notice_url);
    assert.strictEqual(set.onboarded_at, LEGACY_ROW.onboarded_at, 'onboarded_at survives a patch that omits it');
    assert.strictEqual(set.ai_literacy_confirmed_at, LEGACY_ROW.ai_literacy_confirmed_at);
    assert.strictEqual(set.ai_literacy_material_url, LEGACY_ROW.ai_literacy_material_url);
    assert.deepStrictEqual(JSON.parse(set.legal_bases), ['contract']);
    assert.deepStrictEqual(JSON.parse(set.breach_recipients), ['sec@example.test']);
    assert.strictEqual(set.updated_at, 'NOW()');
});

test('legacy: an explicit null in the patch also keeps the stored value (?? fall-through)', async () => {
    settingsRows.push({ ...LEGACY_ROW });
    await store.saveSettings('orgA', {
        dpo_name: null, dpo_email: null, legal_bases: null, data_residency: null,
        default_retention_days: null, privacy_notice_url: null, onboarded_at: null,
        ai_literacy_confirmed_at: null, ai_literacy_material_url: null,
    });
    const set = readUpdate(lastUpdate(), LEGACY_ROW);
    assert.strictEqual(set.dpo_name, 'Dana');
    assert.strictEqual(set.dpo_email, LEGACY_ROW.dpo_email);
    assert.deepStrictEqual(JSON.parse(set.legal_bases), ['contract']);
    assert.strictEqual(set.data_residency, 'hybrid');
    assert.strictEqual(set.default_retention_days, 365);
    assert.strictEqual(set.privacy_notice_url, LEGACY_ROW.privacy_notice_url);
    assert.strictEqual(set.onboarded_at, LEGACY_ROW.onboarded_at);
    assert.strictEqual(set.ai_literacy_confirmed_at, LEGACY_ROW.ai_literacy_confirmed_at);
    assert.strictEqual(set.ai_literacy_material_url, LEGACY_ROW.ai_literacy_material_url);
});

test('legacy: a supplied value replaces the stored one, jsonb goes through JSON.stringify + ::jsonb', async () => {
    settingsRows.push({ ...LEGACY_ROW });
    await store.saveSettings('orgA', {
        legal_bases: ['consent', 'contract'],
        breach_recipients: [],
        default_retention_days: 30,
        onboarded_at: '2026-03-03T00:00:00.000Z',
    });
    const call = lastUpdate();
    const set = readUpdate(call, LEGACY_ROW);
    assert.strictEqual(set.legal_bases, JSON.stringify(['consent', 'contract']));
    assert.strictEqual(set.breach_recipients, '[]', 'an empty list is a real value, not a fall-through');
    assert.strictEqual(set.default_retention_days, 30);
    assert.strictEqual(set.onboarded_at, '2026-03-03T00:00:00.000Z', 'a supplied onboarded_at overwrites');
    assert.match(call.sql, /legal_bases\s*=\s*\$\d+::jsonb/i);
    assert.match(call.sql, /breach_recipients\s*=\s*\$\d+::jsonb/i);
});

test('legacy: INSERT path applies the same defaults when no row exists', async () => {
    await store.saveSettings('orgB', { dpo_name: 'Eerste' });
    const ins = readInsert(lastInsert());
    assert.strictEqual(ins.organization_id, 'orgB');
    assert.strictEqual(ins.dpo_name, 'Eerste');
    assert.strictEqual(ins.dpo_email, null);
    assert.strictEqual(ins.dpo_phone, null);
    assert.strictEqual(ins.legal_bases, '[]');
    assert.strictEqual(ins.data_residency, 'eu');
    assert.strictEqual(ins.breach_recipients, '[]');
    assert.strictEqual(ins.default_retention_days, null);
    assert.strictEqual(ins.privacy_notice_url, null);
    assert.strictEqual(ins.onboarded_at, null);
    assert.strictEqual(ins.ai_literacy_confirmed_at, null);
    assert.strictEqual(ins.ai_literacy_material_url, null);
    assert.ok(!mock.mutations().some(q => /^UPDATE/i.test(q.sql.trim())), 'no UPDATE without a row');
});

test('legacy: unknown keys never reach SQL and every write is org-scoped', async () => {
    settingsRows.push({ ...LEGACY_ROW });
    await store.saveSettings('orgA', { evil_field: 'DROP TABLE', dpo_name: 'x' });
    const call = lastUpdate();
    assert.ok(!call.sql.includes('evil_field'));
    assert.ok(!call.params.includes('DROP TABLE'));
    for (const m of mock.mutations()) {
        assert.match(m.sql, /organization_id/i, `write is org-scoped: ${m.sql.slice(0, 60)}`);
        assert.strictEqual(m.params[0], 'orgA', 'the org is the first parameter');
    }
});

test('legacy: saveSettings returns the re-read settings row', async () => {
    settingsRows.push({ ...LEGACY_ROW });
    const out = await store.saveSettings('orgA', { dpo_name: 'x' });
    assert.strictEqual(out.organization_id, 'orgA');
    assert.ok(mock.calls.getOne.length >= 2, 'reads the row before the write and once more after it');
});

test('getSettings returns the empty shape for an org without a row', async () => {
    const s = await store.getSettings('nobody');
    assert.strictEqual(s.organization_id, 'nobody');
    assert.deepStrictEqual(s.legal_bases, []);
    assert.deepStrictEqual(s.breach_recipients, []);
    assert.strictEqual(s.data_residency, 'eu');
    assert.strictEqual(s.dpo_name, null);
    assert.deepStrictEqual(s.scc_confirmed_operators, []);
});

// ── Table-driven: the redesign's fields ──────────────────────────────────

test('every SETTINGS_FIELDS entry has a distinct column and a known kind; new ones carry DDL', () => {
    const seen = new Set();
    for (const f of store.SETTINGS_FIELDS) {
        assert.ok(!seen.has(f.col), `duplicate column ${f.col}`);
        seen.add(f.col);
        assert.ok(['text', 'jsonb', 'int', 'bool', 'ts', 'date'].includes(f.kind), `${f.col} kind ${f.kind}`);
        if (!f.legacy) assert.match(f.ddl || '', /^(TEXT|JSONB|BOOLEAN|INTEGER|TIMESTAMPTZ|DATE)\b/, `${f.col} has a column type`);
    }
    // The contract's column list (PLAN.md §1.3), verbatim.
    for (const col of [
        'enabled_frameworks', 'framework_relevance',
        'ai_content_marking_enabled', 'ai_content_marking_footer', 'ai_content_marking_enabled_at', 'ai_content_marking_enabled_by',
        'public_base_url', 'sso_enforces_mfa',
        'nis2_entity_class', 'nis2_registration_reference', 'nis2_registered_at', 'nis2_authority_channel', 'nis2_csirt_contact', 'nis2_board_training_at',
        'cra_role', 'cra_reporting_channel', 'psirt_contact_email', 'vuln_disclosure_url', 'security_txt_policy_enabled', 'support_policy_url', 'support_end_date', 'security_update_channel',
        'data_act_provider_role', 'notice_period_days', 'exit_procedure_tested_at', 'exit_procedure_tested_by',
        'accessibility_statement_url', 'accessibility_conformance_level', 'accessibility_conformance_at',
        'incident_customer_contacts', 'dora_customer_notice_hours', 'dora_contract_clauses_confirmed_at', 'dora_contract_clauses_confirmed_by', 'dora_contract_template_url',
        'machinery_manual_subjects',
        // Chat signals (build spec 2.6): owner columns of routes/compliance/chatMonitoring.
        ...CHAT_MONITORING_COLUMNS,
    ]) {
        assert.ok(seen.has(col), `contract column ${col} is writable`);
    }
    // Stamps with their own writer must not be forgeable through PUT /settings.
    for (const col of ['scc_confirmed_operators', 'ropa_reviewed_at', 'ropa_reviewed_by', 'last_retention_run_at']) {
        assert.ok(!seen.has(col), `${col} is not patchable`);
    }
});

test('init issues ADD COLUMN IF NOT EXISTS for every new field and the notify-log table', () => {
    // initDB ran in before(); the mock records DDL through the transaction client.
    const ddl = bootDdl;
    for (const f of store.SETTINGS_FIELDS.filter(f => !f.legacy)) {
        assert.match(ddl, new RegExp(`ADD COLUMN IF NOT EXISTS ${f.col} `), `DDL for ${f.col}`);
    }
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS compliance_notify_log/);
    assert.match(ddl, /ADD COLUMN IF NOT EXISTS scores JSONB DEFAULT '\{\}'::jsonb/);
    assert.match(ddl, /ADD COLUMN IF NOT EXISTS framework_code TEXT/);
    assert.match(ddl, /CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_evidence_seq ON compliance_evidence\(organization_id, seq\) WHERE seq IS NOT NULL/);
});

test('new fields persist with the right casts; absent keys keep the stored value', async () => {
    settingsRows.push({
        ...LEGACY_ROW,
        enabled_frameworks: ['nis2'], framework_relevance: { dora: 'not_relevant' },
        nis2_entity_class: 'important', dora_customer_notice_hours: 4,
    });
    await store.saveSettings('orgA', {
        enabled_frameworks: ['nis2', 'cra'],
        ai_content_marking_enabled: true,
        ai_content_marking_enabled_by: 'u1',
        support_end_date: '2029-12-31',
        notice_period_days: 60,
        incident_customer_contacts: [{ name: 'Bank X', channel: 'email' }],
    });
    const call = lastUpdate();
    const set = readUpdate(call, LEGACY_ROW);
    assert.strictEqual(set.enabled_frameworks, JSON.stringify(['nis2', 'cra']));
    assert.match(call.sql, /enabled_frameworks\s*=\s*\$\d+::jsonb/);
    assert.strictEqual(set.framework_relevance, JSON.stringify({ dora: 'not_relevant' }), 'absent jsonb keeps the stored object');
    assert.strictEqual(set.nis2_entity_class, 'important', 'absent text keeps the stored value');
    assert.strictEqual(set.ai_content_marking_enabled, true);
    assert.strictEqual(set.ai_content_marking_enabled_by, 'u1');
    assert.strictEqual(set.support_end_date, '2029-12-31');
    assert.strictEqual(set.notice_period_days, 60);
    assert.strictEqual(set.dora_customer_notice_hours, 4);
    assert.strictEqual(set.incident_customer_contacts, JSON.stringify([{ name: 'Bank X', channel: 'email' }]));
    assert.strictEqual(set.dpo_name, 'Dana', 'legacy fields untouched by a new-field patch');
});

test('new fields: an explicit null clears the column (fallback for jsonb/bool), unlike the legacy 12', async () => {
    settingsRows.push({
        ...LEGACY_ROW,
        enabled_frameworks: ['nis2'], nis2_registration_reference: 'REG-1',
        ai_content_marking_enabled: true, machinery_manual_subjects: ['m1'],
    });
    await store.saveSettings('orgA', {
        nis2_registration_reference: null,
        enabled_frameworks: null,
        ai_content_marking_enabled: null,
        machinery_manual_subjects: null,
        dpo_name: null,
    });
    const set = readUpdate(lastUpdate(), LEGACY_ROW);
    assert.strictEqual(set.nis2_registration_reference, null);
    assert.strictEqual(set.enabled_frameworks, '[]');
    assert.strictEqual(set.ai_content_marking_enabled, false, 'NOT NULL bool falls back to false');
    assert.strictEqual(set.machinery_manual_subjects, '[]');
    assert.strictEqual(set.dpo_name, 'Dana', 'legacy null still falls through');
});

test('INSERT path seeds the new fields with their defaults', async () => {
    await store.saveSettings('orgC', { enabled_frameworks: ['dora'] });
    const ins = readInsert(lastInsert());
    assert.strictEqual(ins.enabled_frameworks, '["dora"]');
    assert.strictEqual(ins.framework_relevance, '{}');
    assert.strictEqual(ins.ai_content_marking_enabled, false);
    assert.strictEqual(ins.dora_customer_notice_hours, 4);
    assert.strictEqual(ins.incident_customer_contacts, '[]');
    assert.strictEqual(ins.machinery_manual_subjects, '[]');
    assert.strictEqual(ins.nis2_entity_class, null);
    assert.strictEqual(ins.support_end_date, null);
});

test('getSettings parses jsonb columns to arrays/objects with safe defaults', async () => {
    settingsRows.push({
        ...LEGACY_ROW,
        enabled_frameworks: '["nis2","cra"]',          // text-typed driver / legacy import
        framework_relevance: null,                      // NULL cell
        incident_customer_contacts: 'not json at all',  // corrupt
        machinery_manual_subjects: { not: 'an array' }, // wrong shape
        legal_bases: ['contract'],
    });
    const s = await store.getSettings('orgA');
    assert.deepStrictEqual(s.enabled_frameworks, ['nis2', 'cra']);
    assert.deepStrictEqual(s.framework_relevance, {});
    assert.deepStrictEqual(s.incident_customer_contacts, []);
    assert.deepStrictEqual(s.machinery_manual_subjects, []);
    assert.deepStrictEqual(s.legal_bases, ['contract']);
});

test('getSettings empty shape carries every new field with its default', async () => {
    const s = await store.getSettings('fresh');
    assert.deepStrictEqual(s.enabled_frameworks, []);
    assert.deepStrictEqual(s.framework_relevance, {});
    assert.strictEqual(s.ai_content_marking_enabled, false);
    assert.strictEqual(s.dora_customer_notice_hours, 4);
    assert.deepStrictEqual(s.incident_customer_contacts, []);
    assert.strictEqual(s.cra_role, null);
    assert.strictEqual(s.support_end_date, null);
    // defaults are fresh copies, never the shared fallback object
    s.enabled_frameworks.push('x');
    assert.deepStrictEqual((await store.getSettings('fresh')).enabled_frameworks, []);
});

// ── compliance_notify_log ────────────────────────────────────────────────

test('markNotified inserts once per (org, kind, id, offset) and reports whether it did', async () => {
    assert.strictEqual(await store.markNotified('orgA', 'dsr', 42, '7d'), true, 'first call inserts');
    assert.strictEqual(await store.markNotified('orgA', 'dsr', 42, '7d'), false, 'repeat is a no-op');
    assert.strictEqual(await store.markNotified('orgA', 'dsr', 42, '1d'), true, 'another tier is a new row');
    assert.strictEqual(await store.markNotified('orgB', 'dsr', 42, '7d'), true, 'another org is a new row');
    for (const m of mock.mutations()) {
        assert.match(m.sql, /ON CONFLICT \(organization_id, subject_kind, subject_id, offset_key\) DO NOTHING/);
        assert.match(m.sql, /organization_id/);
    }
    assert.strictEqual(await store.wasNotified('orgA', 'dsr', 42, '7d'), true);
    assert.strictEqual(await store.wasNotified('orgA', 'dsr', 42, 'overdue'), false);
    assert.strictEqual(await store.wasNotified('orgC', 'dsr', 42, '7d'), false, 'lookups are org-scoped');
});

// ── The request boundary: sanitizeSettingsPatch ──────────────────────────
//
// saveSettings is the INTERNAL writer (frameworkPolicy, a check's auto-fix and
// the settings route all use it). sanitizeSettingsPatch is what an untrusted
// PUT body must pass through first, and these tests pin the three things it
// owes the route: owner-written columns never come from a body, values are
// coerced to their declared column type, and a rejection names fields only.

test('SETTINGS_REQUEST_DENY names exactly the owner-written columns, and every one is a real field', () => {
    assert.deepStrictEqual([...store.SETTINGS_REQUEST_DENY], [
        'enabled_frameworks', 'framework_relevance',
        'ai_content_marking_enabled_at', 'ai_content_marking_enabled_by',
        ...CHAT_MONITORING_COLUMNS,
    ]);
    const cols = new Set(store.SETTINGS_FIELDS.map(f => f.col));
    for (const col of store.SETTINGS_REQUEST_DENY) {
        assert.ok(cols.has(col), `${col} is still a writable column (DDL + read shape)`);
        assert.ok(store.SETTINGS_FIELDS.find(f => f.col === col).owner, `${col} declares its owner`);
    }
});

test('the chat signals columns: twenty, each owned by the chat monitoring route, each with DDL', () => {
    const fields = store.SETTINGS_FIELDS.filter(f => f.col.startsWith('chat_monitoring_'));
    assert.deepStrictEqual(fields.map(f => f.col), CHAT_MONITORING_COLUMNS);
    for (const f of fields) {
        assert.equal(f.owner, 'routes/compliance/chatMonitoring', `${f.col} is owned by the route`);
        assert.ok(f.ddl, `${f.col} has DDL`);
    }
    const retention = fields.find(f => f.col === 'chat_monitoring_retention_days');
    assert.deepStrictEqual([retention.min, retention.max], [30, 90]);
    const empty = store.SETTINGS_FIELDS.find(f => f.col === 'chat_monitoring_enabled');
    assert.equal(empty.fallback, false, 'off unless the route says otherwise');
});

test('sanitizeSettingsPatch drops every chat_monitoring_* key, also from a Playbooks-shaped plan body', () => {
    const forged = Object.fromEntries(CHAT_MONITORING_COLUMNS.map(c => [c, c.endsWith('_enabled') ? true : 'x']));
    assert.deepStrictEqual(store.sanitizeSettingsPatch({ ...forged, dpo_name: 'Dana' }), { dpo_name: 'Dana' });
    // A model-planned body that the Playbooks resolver posts to PUT /settings:
    // the switch, its surfaces and a forged start date must not get through.
    const plan = {
        dpo_email: 'dpo@example.org',
        chat_monitoring_enabled: true,
        chat_monitoring_surfaces: ['direct', 'agent'],
        chat_monitoring_signals: ['outcomes', 'kinds'],
        chat_monitoring_effective_from: '2020-01-01T00:00:00Z',
        chat_monitoring_works_council: 'not_applicable',
        chat_monitoring_enabled_by: 'planner',
    };
    assert.deepStrictEqual(store.sanitizeSettingsPatch(plan), { dpo_email: 'dpo@example.org' });
});

test('a body cannot forge the AI Act Art. 50(2) attestation stamp', () => {
    const patch = store.sanitizeSettingsPatch({
        ai_content_marking_enabled_by: 'someone-else',
        ai_content_marking_enabled_at: '2020-01-01T00:00:00Z',
        ai_content_marking_enabled: true,
        ai_content_marking_footer: 'Gemaakt met AI',
    });
    assert.deepStrictEqual(patch, { ai_content_marking_enabled: true, ai_content_marking_footer: 'Gemaakt met AI' });
});

test('a body cannot write the framework state — that is frameworkPolicy\'s (licence, events, relevance meta)', async () => {
    const patch = store.sanitizeSettingsPatch({
        enabled_frameworks: ['nis2', 'dora'],
        framework_relevance: { dora: 'relevant' },
        cra_role: 'manufacturer',
    });
    assert.deepStrictEqual(patch, { cra_role: 'manufacturer' });

    // End to end: the stored framework columns survive such a body untouched.
    settingsRows.push({
        ...LEGACY_ROW,
        enabled_frameworks: ['cra'],
        framework_relevance: { dora: 'not_relevant', meta: { dora: { set_by: 'u9', set_at: '2026-09-01T00:00:00.000Z', note: null } } },
    });
    await store.saveSettings('orgA', patch);
    const set = readUpdate(lastUpdate(), LEGACY_ROW);
    assert.strictEqual(set.enabled_frameworks, JSON.stringify(['cra']), 'enabled_frameworks untouched');
    assert.strictEqual(
        set.framework_relevance,
        JSON.stringify({ dora: 'not_relevant', meta: { dora: { set_by: 'u9', set_at: '2026-09-01T00:00:00.000Z', note: null } } }),
        'the relevance audit trail is not wiped',
    );
    assert.strictEqual(set.cra_role, 'manufacturer');
});

test('values are coerced to the declared column type; absent stays absent and null still clears', () => {
    const patch = store.sanitizeSettingsPatch({
        notice_period_days: '60',                   // int as a string
        dora_customer_notice_hours: 8,
        sso_enforces_mfa: 'true',                   // bool as a string
        data_act_provider_role: false,
        support_end_date: '2029-12-31',
        exit_procedure_tested_at: new Date('2026-09-14T10:00:00Z'),
        nis2_registered_at: '2026-01-02',
        incident_customer_contacts: [{ channel: 'email' }],
        nis2_entity_class: null,                    // explicit clear survives
        cra_role: undefined,                        // undefined is absent
    });
    assert.deepStrictEqual(patch, {
        notice_period_days: 60,
        dora_customer_notice_hours: 8,
        sso_enforces_mfa: true,
        data_act_provider_role: false,
        support_end_date: '2029-12-31',
        exit_procedure_tested_at: '2026-09-14T10:00:00.000Z',
        nis2_registered_at: '2026-01-02T00:00:00.000Z',
        incident_customer_contacts: [{ channel: 'email' }],
        nis2_entity_class: null,
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(patch, 'cra_role'));
});

test('a value that does not fit its column is a 400 naming the field — not a rejected UPDATE', () => {
    let err = null;
    try {
        store.sanitizeSettingsPatch({
            support_end_date: 'soon',
            notice_period_days: 'thirty',
            data_act_provider_role: 'yes',
            nis2_registered_at: 'someday',
            legal_bases: '["contract"]',        // a JSON string would double-encode
            framework_relevance: { dora: 'x' }, // denied, never validated
            dpo_name: 'Dana',                   // the valid rest of the same submit
        });
    } catch (e) { err = e; }
    assert.ok(err instanceof store.SettingsValidationError, 'throws SettingsValidationError');
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.body.error, 'invalid_setting');
    assert.deepStrictEqual(err.body.fields, [
        { field: 'legal_bases', expected: 'a JSON array' },
        { field: 'nis2_registered_at', expected: 'an ISO-8601 timestamp' },
        { field: 'support_end_date', expected: 'a date (YYYY-MM-DD)' },
        { field: 'data_act_provider_role', expected: 'a boolean' },
        { field: 'notice_period_days', expected: 'an integer' },
    ]);
});

test('a rejection carries field names and expected types only — never the submitted value (BFSF-441)', () => {
    let err = null;
    try {
        store.sanitizeSettingsPatch({ dpo_email: { address: 'dana@example.test' }, dpo_phone: ['+31 6 000 000'] });
    } catch (e) { err = e; }
    assert.ok(err, 'a non-string for a text column is refused');
    assert.deepStrictEqual(err.body.fields, [
        { field: 'dpo_email', expected: 'a string' },
        { field: 'dpo_phone', expected: 'a string' },
    ]);
    const leaked = `${err.message} ${JSON.stringify(err.body)}`;
    assert.ok(!leaked.includes('dana@example.test'), 'no e-mail in the error');
    assert.ok(!leaked.includes('+31 6 000 000'), 'no phone number in the error');
});

test('an impossible calendar date is refused before Postgres sees it', () => {
    assert.throws(() => store.sanitizeSettingsPatch({ support_end_date: '2029-02-31' }), store.SettingsValidationError);
    assert.deepStrictEqual(store.sanitizeSettingsPatch({ support_end_date: '2029-02-28' }), { support_end_date: '2029-02-28' });
});

test('sanitizeSettingsPatch drops unknown keys and tolerates a missing body', () => {
    assert.deepStrictEqual(store.sanitizeSettingsPatch({ evil_field: 'DROP TABLE', dpo_name: 'x' }), { dpo_name: 'x' });
    assert.deepStrictEqual(store.sanitizeSettingsPatch(undefined), {});
    assert.deepStrictEqual(store.sanitizeSettingsPatch(null), {});
    assert.deepStrictEqual(store.sanitizeSettingsPatch('nope'), {});
});

// ── The domain half of the boundary ──────────────────────────────────────
//
// A value can BE an integer, a timestamp or a JSON array and still be one
// Postgres refuses — and a refused bind takes the WHOLE update with it, which
// is the exact failure the type coercion above was added to prevent. Each case
// below was reproduced against Postgres 17 + the pg driver first; the error it
// would otherwise raise is named in the test.

const NUL = String.fromCharCode(0); // U+0000, never a literal in source

test('every int column declares its own domain, and the domain fits in int4', () => {
    const ints = store.SETTINGS_FIELDS.filter(f => f.kind === 'int');
    assert.ok(ints.length >= 3, 'the int columns are still there');
    for (const f of ints) {
        assert.ok(Number.isInteger(f.min), `${f.col} declares a minimum`);
        assert.ok(Number.isInteger(f.max), `${f.col} declares a maximum`);
        assert.ok(f.min < f.max, `${f.col} has a non-empty domain`);
        assert.ok(f.min >= -2147483648 && f.max <= 2147483647, `${f.col} stays inside int4`);
    }
});

test('an integer past its column domain is refused here — Postgres would reject the whole UPDATE', () => {
    // psql: SELECT 99999999999::int4 -> ERROR: integer out of range.
    let err = null;
    try {
        store.sanitizeSettingsPatch({
            default_retention_days: '99999999999',   // a pasted long number in a number input
            notice_period_days: 99999999999,
            dora_customer_notice_hours: -1,
            dpo_name: 'Dana',                        // the valid rest of the same submit
        });
    } catch (e) { err = e; }
    assert.ok(err instanceof store.SettingsValidationError, 'throws SettingsValidationError');
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.body.error, 'invalid_setting');
    assert.deepStrictEqual(err.body.fields, [
        { field: 'default_retention_days', expected: 'an integer between 0 and 36500' },
        { field: 'notice_period_days', expected: 'an integer between 0 and 3650' },
        { field: 'dora_customer_notice_hours', expected: 'an integer between 0 and 8760' },
    ]);
    const leaked = `${err.message} ${JSON.stringify(err.body)}`;
    assert.ok(!leaked.includes('99999999999'), 'the submitted value is never echoed back (BFSF-441)');
    assert.ok(!leaked.includes('Dana'), 'nor any other submitted value');
});

test('the edges of each int domain still save, and a non-integer keeps its own message', () => {
    assert.deepStrictEqual(
        store.sanitizeSettingsPatch({ default_retention_days: 36500, notice_period_days: 0, dora_customer_notice_hours: '8760' }),
        { default_retention_days: 36500, notice_period_days: 0, dora_customer_notice_hours: 8760 },
    );
    let err = null;
    try { store.sanitizeSettingsPatch({ default_retention_days: 'forever' }); } catch (e) { err = e; }
    assert.deepStrictEqual(err.body.fields, [{ field: 'default_retention_days', expected: 'an integer' }]);
});

test('a year Postgres cannot store is refused before the driver sees it', () => {
    // psql: date '0000-01-01' -> ERROR: date/time field value out of range.
    //       timestamptz '+275760-09-13T00:00:00.000Z' -> ERROR: time zone
    //       displacement out of range (JS Date accepts that extended-year form
    //       and toISOString() round-trips it, so it passed the type check).
    //       timestamptz '-000001-01-01T00:00:00.000Z' -> ERROR: invalid input syntax.
    for (const body of [
        { support_end_date: '0000-01-01' },
        { support_end_date: '275760-09-13' },
        { nis2_registered_at: '+275760-09-13T00:00:00.000Z' },
        { nis2_registered_at: '-000001-01-01T00:00:00Z' },
    ]) {
        assert.throws(() => store.sanitizeSettingsPatch(body), store.SettingsValidationError, `refused: ${JSON.stringify(body)}`);
    }
    // The years a compliance stamp actually falls in still pass, unchanged.
    assert.deepStrictEqual(store.sanitizeSettingsPatch({ support_end_date: '9999-12-31' }), { support_end_date: '9999-12-31' });
    assert.deepStrictEqual(store.sanitizeSettingsPatch({ nis2_registered_at: '1900-01-01T00:00:00Z' }), { nis2_registered_at: '1900-01-01T00:00:00.000Z' });
});

test('a NUL character is refused for text and for jsonb — neither column can hold one', () => {
    // pg driver: a text bind carrying 0x00 -> invalid byte sequence for encoding
    // "UTF8": 0x00. A jsonb bind whose JSON carries the u0000 escape ->
    // unsupported Unicode escape sequence (it cannot be converted to text).
    let err = null;
    try {
        store.sanitizeSettingsPatch({
            dpo_name: `Dana${NUL}`,
            breach_recipients: [`sec@example.test${NUL}`],
            machinery_manual_subjects: ['safety'],     // the valid rest of the submit
        });
    } catch (e) { err = e; }
    assert.ok(err instanceof store.SettingsValidationError);
    assert.deepStrictEqual(err.body.fields, [
        { field: 'dpo_name', expected: 'a string without NUL characters' },
        { field: 'breach_recipients', expected: 'a JSON array without NUL characters' },
    ]);
    const leaked = `${err.message} ${JSON.stringify(err.body)}`;
    assert.ok(!leaked.includes('Dana'), 'no DPO name in the error (BFSF-441)');
    assert.ok(!leaked.includes('sec@example.test'), 'no breach recipient in the error');
    // Nested values and object KEYS are walked too, not just the top level.
    assert.throws(
        () => store.sanitizeSettingsPatch({ incident_customer_contacts: [{ channel: `email${NUL}` }] }),
        store.SettingsValidationError,
    );
    assert.throws(
        () => store.sanitizeSettingsPatch({ incident_customer_contacts: [{ [`chan${NUL}`]: 'email' }] }),
        store.SettingsValidationError,
    );
});

test('a jsonb value nested past any real shape is refused, not a stack overflow mid-save', () => {
    // JSON.stringify (in _mergeField, before Postgres is reached) throws
    // "Maximum call stack size exceeded" from ~4 000 levels: a 500 with a raw
    // runtime message and the whole submit gone, the same wound by another
    // route. The walk that catches it must not recurse either.
    let deep = 'x';
    for (let i = 0; i < 5000; i++) deep = [deep];
    let err = null;
    try { store.sanitizeSettingsPatch({ machinery_manual_subjects: [deep] }); } catch (e) { err = e; }
    assert.ok(err instanceof store.SettingsValidationError, 'a typed 400, not a RangeError');
    assert.deepStrictEqual(err.body.fields, [{ field: 'machinery_manual_subjects', expected: 'a JSON array nested at most 20 levels deep' }]);
    // The shapes these columns really hold are one record deep and still pass.
    assert.deepStrictEqual(
        store.sanitizeSettingsPatch({ incident_customer_contacts: [{ channel: 'email', address: 'ops@example.test' }] }),
        { incident_customer_contacts: [{ channel: 'email', address: 'ops@example.test' }] },
    );
});

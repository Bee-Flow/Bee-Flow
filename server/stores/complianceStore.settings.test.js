// @typecheck
/**
 * complianceStore — settings persistence, against a real Postgres (PGlite
 * behind db.js's pool, testUtils/pglitePool.js) with the store's own schema.
 *
 * The first block pins the merge semantics of the legacy columns, read back
 * from the row:
 *
 *   - a field ABSENT from the patch keeps the stored value;
 *   - an explicit `null` in the patch ALSO keeps the stored value (`??`
 *     fall-through — the legacy UPDATE could never clear a column);
 *   - `data_residency` falls back to 'eu', the jsonb lists to `[]`, everything
 *     else to null when neither patch nor row carries a value;
 *   - the INSERT path (no row yet) applies exactly the same values;
 *   - unknown keys never reach the row; updated_at moves on every UPDATE.
 *
 * The later blocks cover what the table-driven store adds: the framework and
 * regulation columns of the redesign, jsonb parsing on read, and the
 * compliance_notify_log tier log.
 *
 * Run: cd server && node --test stores/complianceStore.settings.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { pinPgliteNow } = require('../testUtils/pgliteClock');
const { insertRow } = require('../testUtils/pgliteSeed');

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

const { pg, close } = usePglitePool();
const store = require('./complianceStore');

const NOW = new Date('2026-09-14T12:00:00.000Z');
/** @type {{ set: (at: Date | string) => Promise<void> }} */
let clock;
before(async () => {
    await store.initDB();
    clock = await pinPgliteNow(pg, NOW);
});
after(close);
beforeEach(async () => {
    await pg.exec('TRUNCATE compliance_settings, compliance_notify_log');
    await clock.set(NOW);
});

const stored = async (org = 'orgA') => (await pg.query('SELECT * FROM compliance_settings WHERE organization_id = $1', [org])).rows[0];
const iso = (d) => (d == null ? null : new Date(d).toISOString());

const LEGACY_ROW = {
    organization_id: 'orgA',
    dpo_name: 'Dana', dpo_email: 'dpo@example.test', dpo_phone: '+31 6 000',
    legal_bases: ['contract'], data_residency: 'hybrid',
    breach_recipients: ['sec@example.test'], default_retention_days: 365,
    privacy_notice_url: 'https://example.test/privacy',
    onboarded_at: '2026-01-01T00:00:00.000Z',
    ai_literacy_confirmed_at: '2026-02-01T00:00:00.000Z',
    ai_literacy_material_url: 'https://example.test/ai-literacy',
};
const seedRow = (over = {}) => insertRow(pg, 'compliance_settings', { ...LEGACY_ROW, updated_at: '2026-01-01T00:00:00.000Z', ...over });

// ── Characterisation: the legacy fields ──────────────────────────────────

test('legacy: a field absent from the patch keeps the stored value (UPDATE path)', async () => {
    await seedRow();
    await store.saveSettings('orgA', { dpo_name: 'Nieuw' });
    const row = await stored();
    assert.strictEqual(row.dpo_name, 'Nieuw');
    assert.strictEqual(row.dpo_email, LEGACY_ROW.dpo_email);
    assert.strictEqual(row.dpo_phone, LEGACY_ROW.dpo_phone);
    assert.strictEqual(row.data_residency, 'hybrid');
    assert.strictEqual(row.default_retention_days, 365);
    assert.strictEqual(row.privacy_notice_url, LEGACY_ROW.privacy_notice_url);
    assert.strictEqual(iso(row.onboarded_at), LEGACY_ROW.onboarded_at, 'onboarded_at survives a patch that omits it');
    assert.strictEqual(iso(row.ai_literacy_confirmed_at), LEGACY_ROW.ai_literacy_confirmed_at);
    assert.strictEqual(row.ai_literacy_material_url, LEGACY_ROW.ai_literacy_material_url);
    assert.deepStrictEqual(row.legal_bases, ['contract']);
    assert.deepStrictEqual(row.breach_recipients, ['sec@example.test']);
    assert.strictEqual(iso(row.updated_at), NOW.toISOString());
});

test('legacy: an explicit null in the patch also keeps the stored value (?? fall-through)', async () => {
    await seedRow();
    await store.saveSettings('orgA', {
        dpo_name: null, dpo_email: null, legal_bases: null, data_residency: null,
        default_retention_days: null, privacy_notice_url: null, onboarded_at: null,
        ai_literacy_confirmed_at: null, ai_literacy_material_url: null,
    });
    const row = await stored();
    assert.strictEqual(row.dpo_name, 'Dana');
    assert.strictEqual(row.dpo_email, LEGACY_ROW.dpo_email);
    assert.deepStrictEqual(row.legal_bases, ['contract']);
    assert.strictEqual(row.data_residency, 'hybrid');
    assert.strictEqual(row.default_retention_days, 365);
    assert.strictEqual(row.privacy_notice_url, LEGACY_ROW.privacy_notice_url);
    assert.strictEqual(iso(row.onboarded_at), LEGACY_ROW.onboarded_at);
    assert.strictEqual(iso(row.ai_literacy_confirmed_at), LEGACY_ROW.ai_literacy_confirmed_at);
    assert.strictEqual(row.ai_literacy_material_url, LEGACY_ROW.ai_literacy_material_url);
});

test('legacy: a supplied value replaces the stored one, jsonb included', async () => {
    await seedRow();
    await store.saveSettings('orgA', {
        legal_bases: ['consent', 'contract'],
        breach_recipients: [],
        default_retention_days: 30,
        onboarded_at: '2026-03-03T00:00:00.000Z',
    });
    const row = await stored();
    assert.deepStrictEqual(row.legal_bases, ['consent', 'contract']);
    assert.deepStrictEqual(row.breach_recipients, [], 'an empty list is a real value, not a fall-through');
    assert.strictEqual(row.default_retention_days, 30);
    assert.strictEqual(iso(row.onboarded_at), '2026-03-03T00:00:00.000Z', 'a supplied onboarded_at overwrites');
});

test('legacy: INSERT path applies the same defaults when no row exists', async () => {
    await store.saveSettings('orgB', { dpo_name: 'Eerste' });
    const row = await stored('orgB');
    assert.strictEqual(row.dpo_name, 'Eerste');
    assert.strictEqual(row.dpo_email, null);
    assert.strictEqual(row.dpo_phone, null);
    assert.deepStrictEqual(row.legal_bases, []);
    assert.strictEqual(row.data_residency, 'eu');
    assert.deepStrictEqual(row.breach_recipients, []);
    assert.strictEqual(row.default_retention_days, null);
    assert.strictEqual(row.privacy_notice_url, null);
    assert.strictEqual(row.onboarded_at, null);
    assert.strictEqual(row.ai_literacy_confirmed_at, null);
    assert.strictEqual(row.ai_literacy_material_url, null);
    assert.strictEqual(await stored('orgA'), undefined, 'and no other organisation got a row');
});

test('legacy: unknown keys never reach the row and every write is org-scoped', async () => {
    await seedRow();
    await seedRow({ organization_id: 'orgB', dpo_name: 'Bea' });
    await store.saveSettings('orgA', { evil_field: 'DROP TABLE', dpo_name: 'x' });
    const row = await stored();
    assert.strictEqual(row.dpo_name, 'x');
    assert.ok(!('evil_field' in row));
    assert.ok(!Object.values(row).includes('DROP TABLE'));
    assert.strictEqual((await stored('orgB')).dpo_name, 'Bea', 'another organisation is untouched');
});

test('legacy: saveSettings returns the re-read settings row', async () => {
    await seedRow();
    const out = await store.saveSettings('orgA', { dpo_name: 'x' });
    assert.strictEqual(out.organization_id, 'orgA');
    assert.strictEqual(out.dpo_name, 'x');
    assert.deepStrictEqual(out.legal_bases, ['contract']);
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

test('init adds a column for every new field, the notify-log table, and the evidence columns and index', async () => {
    const cols = async (table) => new Set((await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map((r) => r.column_name));
    const settingsCols = await cols('compliance_settings');
    for (const f of store.SETTINGS_FIELDS) assert.ok(settingsCols.has(f.col), `a column for ${f.col}`);
    assert.ok((await cols('compliance_notify_log')).has('offset_key'));
    const { rows } = await pg.query(`SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
        WHERE (table_name, column_name) IN (('compliance_score_history', 'scores'), ('compliance_checks', 'framework_code'))
        ORDER BY table_name`);
    assert.deepStrictEqual(rows.map((r) => [r.table_name, r.data_type]), [['compliance_checks', 'text'], ['compliance_score_history', 'jsonb']]);
    assert.match(rows[1].column_default, /'\{\}'::jsonb/);
    const idx = await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_compliance_evidence_seq'`);
    assert.match(idx.rows[0].indexdef, /UNIQUE INDEX .* \(organization_id, seq\) WHERE \(seq IS NOT NULL\)/);
});

test('new fields persist with the right types; absent keys keep the stored value', async () => {
    await seedRow({ enabled_frameworks: ['nis2'], framework_relevance: { dora: 'not_relevant' }, nis2_entity_class: 'important', dora_customer_notice_hours: 4 });
    await store.saveSettings('orgA', {
        enabled_frameworks: ['nis2', 'cra'],
        ai_content_marking_enabled: true,
        ai_content_marking_enabled_by: 'u1',
        support_end_date: '2029-12-31',
        notice_period_days: 60,
        incident_customer_contacts: [{ name: 'Bank X', channel: 'email' }],
    });
    const row = await stored();
    assert.deepStrictEqual(row.enabled_frameworks, ['nis2', 'cra']);
    assert.deepStrictEqual(row.framework_relevance, { dora: 'not_relevant' }, 'absent jsonb keeps the stored object');
    assert.strictEqual(row.nis2_entity_class, 'important', 'absent text keeps the stored value');
    assert.strictEqual(row.ai_content_marking_enabled, true);
    assert.strictEqual(row.ai_content_marking_enabled_by, 'u1');
    assert.strictEqual(iso(row.support_end_date).slice(0, 10), '2029-12-31');
    assert.strictEqual(row.notice_period_days, 60);
    assert.strictEqual(row.dora_customer_notice_hours, 4);
    assert.deepStrictEqual(row.incident_customer_contacts, [{ name: 'Bank X', channel: 'email' }]);
    assert.strictEqual(row.dpo_name, 'Dana', 'legacy fields untouched by a new-field patch');
});

test('new fields: an explicit null clears the column (fallback for jsonb/bool), unlike the legacy fields', async () => {
    await seedRow({ enabled_frameworks: ['nis2'], nis2_registration_reference: 'REG-1', ai_content_marking_enabled: true, machinery_manual_subjects: ['m1'] });
    await store.saveSettings('orgA', {
        nis2_registration_reference: null,
        enabled_frameworks: null,
        ai_content_marking_enabled: null,
        machinery_manual_subjects: null,
        dpo_name: null,
    });
    const row = await stored();
    assert.strictEqual(row.nis2_registration_reference, null);
    assert.deepStrictEqual(row.enabled_frameworks, []);
    assert.strictEqual(row.ai_content_marking_enabled, false, 'NOT NULL bool falls back to false');
    assert.deepStrictEqual(row.machinery_manual_subjects, []);
    assert.strictEqual(row.dpo_name, 'Dana', 'legacy null still falls through');
});

test('INSERT path seeds the new fields with their defaults', async () => {
    await store.saveSettings('orgC', { enabled_frameworks: ['dora'] });
    const row = await stored('orgC');
    assert.deepStrictEqual(row.enabled_frameworks, ['dora']);
    assert.deepStrictEqual(row.framework_relevance, {});
    assert.strictEqual(row.ai_content_marking_enabled, false);
    assert.strictEqual(row.dora_customer_notice_hours, 4);
    assert.deepStrictEqual(row.incident_customer_contacts, []);
    assert.deepStrictEqual(row.machinery_manual_subjects, []);
    assert.strictEqual(row.nis2_entity_class, null);
    assert.strictEqual(row.support_end_date, null);
});

test('getSettings parses jsonb columns to arrays/objects with safe defaults', async () => {
    await seedRow({
        enabled_frameworks: JSON.stringify('["nis2","cra"]'), // a JSON-encoded string (legacy import)
        framework_relevance: null,                             // NULL cell
        incident_customer_contacts: JSON.stringify('not json at all'),
        machinery_manual_subjects: { not: 'an array' },        // wrong shape
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
    assert.strictEqual((await pg.query('SELECT count(*)::int AS n FROM compliance_notify_log')).rows[0].n, 3);
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
    const relevance = { dora: 'not_relevant', meta: { dora: { set_by: 'u9', set_at: '2026-09-01T00:00:00.000Z', note: null } } };
    await seedRow({ enabled_frameworks: ['cra'], framework_relevance: relevance });
    await store.saveSettings('orgA', patch);
    const row = await stored();
    assert.deepStrictEqual(row.enabled_frameworks, ['cra'], 'enabled_frameworks untouched');
    assert.deepStrictEqual(row.framework_relevance, relevance, 'the relevance audit trail is not wiped');
    assert.strictEqual(row.cra_role, 'manufacturer');
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
    let deep = /** @type {any} */ ('x');
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

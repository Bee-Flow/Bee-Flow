// @typecheck
/**
 * Compliance Store — AI Act & GDPR monitoring persistence.
 *
 * Tables:
 *   compliance_settings      org-wide onboarding answers (DPO, legal bases, residency,
 *                            retention, SCC attestations, RoPA review timestamp,
 *                            retention-job heartbeat) plus, since the Compliance
 *                            Center redesign, the per-org framework set and the
 *                            regulation-specific attestation fields (NIS2, CRA/PLD,
 *                            Data Act, EAA, DORA, Machinery). Writes go through the
 *                            table-driven saveSettings — SETTINGS_FIELDS is the
 *                            whitelist.
 *   compliance_checks        time-series check results (one row per check run).
 *   compliance_evidence      append-only audit trail. Every row is a link in a
 *                            per-org hash chain (seq / prev_hash / payload_hash /
 *                            hash) — see addEvidence.
 *   compliance_score_history one snapshot per full runAll() sweep; `scores` JSONB
 *                            keyed by framework id, the legacy three columns kept.
 *   compliance_notify_log    idempotency log for the deadline notifier's tiers.
 */

const { run, getOne, getAll, exec, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');

const initDB = makeStoreInit('ComplianceStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_settings (
            organization_id TEXT PRIMARY KEY,
            dpo_name TEXT,
            dpo_email TEXT,
            dpo_phone TEXT,
            legal_bases JSONB DEFAULT '[]'::jsonb,
            data_residency TEXT DEFAULT 'eu',
            breach_recipients JSONB DEFAULT '[]'::jsonb,
            default_retention_days INTEGER,
            privacy_notice_url TEXT,
            onboarded_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    // Additive columns introduced by Compliance Hub v2 — via runDdl
    // (stores/lib/_ddl.js): fouten per statement luid verzameld i.p.v.
    // stil weggeslikt door .catch(() => {}).
    await runDdl('complianceStore', [
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS scc_confirmed_operators JSONB DEFAULT '[]'::jsonb`,
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS ropa_reviewed_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS ropa_reviewed_by TEXT`,
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS last_retention_run_at TIMESTAMPTZ`,
        // How often a registered processing has to be re-confirmed —
        // Art. 30(4), read by GDPR-Art30-datatable-registrations.
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS datatable_review_days INTEGER`,
        // EU AI Act Art. 4 — AI-literacy attestation (v3 additive columns).
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS ai_literacy_confirmed_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS ai_literacy_material_url TEXT`,
        // Compliance Center redesign (2026-09): frameworks as a growing,
        // licence-gated set + the attestation fields the new checks read.
        // Column list = SETTINGS_FIELDS below; kept in sync by the test.
        ...SETTINGS_FIELDS.filter(f => !f.legacy).map(f =>
            `ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS ${f.col} ${f.ddl}`),
    ]);

    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_checks (
            id SERIAL PRIMARY KEY,
            organization_id TEXT,
            check_id TEXT NOT NULL,
            regulation TEXT NOT NULL,
            article TEXT,
            severity TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL,
            evidence JSONB DEFAULT '{}'::jsonb,
            details TEXT,
            scope_type TEXT DEFAULT 'global',
            scope_id TEXT,
            run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            run_type TEXT DEFAULT 'scheduled'
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_org_run ON compliance_checks(organization_id, run_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_check_id ON compliance_checks(organization_id, check_id, run_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_scope ON compliance_checks(scope_type, scope_id)`);
    // Latest-per-(check, scope) lookups; underpins /overview perf.
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_latest ON compliance_checks(organization_id, check_id, scope_type, scope_id, run_at DESC)`);

    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_evidence (
            id SERIAL PRIMARY KEY,
            organization_id TEXT,
            check_id TEXT,
            subject_type TEXT,
            subject_id TEXT,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            hash TEXT,
            payload JSONB DEFAULT '{}'::jsonb
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_evidence_org ON compliance_evidence(organization_id, captured_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_evidence_check ON compliance_evidence(organization_id, check_id, captured_at DESC)`);

    // One snapshot per full runAll() sweep — powers the score-over-time
    // trend. Reconstructing "score as of day X" from the compliance_checks
    // time-series is ambiguous (per-source subjects appear and disappear),
    // so we persist the number the org actually saw at run time.
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_score_history (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            overall_score INTEGER,
            gdpr_score INTEGER,
            aia_score INTEGER,
            pass INTEGER, warn INTEGER, fail INTEGER, na INTEGER,
            run_type TEXT,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_score_hist ON compliance_score_history(organization_id, captured_at DESC)`);

    // Idempotency log for the deadline notifier: one row per (subject,
    // tier) that has been sent. The PK is the whole key, so a second
    // sweep hitting the same tier is a no-op INSERT … ON CONFLICT.
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_notify_log (
            organization_id TEXT NOT NULL,
            subject_kind TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            offset_key TEXT NOT NULL,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (organization_id, subject_kind, subject_id, offset_key)
        )
    `);

    await runDdl('complianceStore', [
        // ISO 27001 as third scored framework (additive).
        `ALTER TABLE compliance_score_history ADD COLUMN IF NOT EXISTS iso_score INTEGER`,
        // Per-framework scores keyed by framework id ({gdpr, aia, iso27001,
        // nis2, …, "custom:<uuid>"}). The legacy three columns keep being
        // written; old rows are synthesised on read (getScoreHistory).
        `ALTER TABLE compliance_score_history ADD COLUMN IF NOT EXISTS scores JSONB DEFAULT '{}'::jsonb`,
        // What the score of this sweep was computed OVER: how many of the
        // things a check can enumerate it actually examined, and which it
        // never did (compliance/runner.js `_coverageSummary`). Kept on the
        // same row as the number so a trend point can never be read as
        // complete when half the workspace sat outside it. NULL on rows
        // written before this column — "not recorded", not "all covered".
        `ALTER TABLE compliance_score_history ADD COLUMN IF NOT EXISTS coverage JSONB`,
        // File evidence (pentest reports, certificates, NDAs, MR minutes):
        // the row keeps the sha256 + metadata, the bytes live in object storage.
        `ALTER TABLE compliance_evidence ADD COLUMN IF NOT EXISTS storage_key TEXT`,
        // Evidence chain (A.5.28): per-org monotonic seq, the previous
        // link's hash and the canonical payload digest. Rows written before
        // the chain keep seq NULL and are shape-checked only — append-only,
        // no backfill.
        `ALTER TABLE compliance_evidence ADD COLUMN IF NOT EXISTS seq BIGINT`,
        `ALTER TABLE compliance_evidence ADD COLUMN IF NOT EXISTS prev_hash TEXT`,
        `ALTER TABLE compliance_evidence ADD COLUMN IF NOT EXISTS payload_hash TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_evidence_seq ON compliance_evidence(organization_id, seq) WHERE seq IS NOT NULL`,
        // Custom (org-defined) frameworks persist their results with
        // regulation 'CUSTOM' + the framework code, so a per-framework
        // score is a plain filter on this column.
        `ALTER TABLE compliance_checks ADD COLUMN IF NOT EXISTS framework_code TEXT`,
    ]);

    await runDdl('complianceStore', FINDING_DDL);
}

// ───────────────────────── Finding states, registrations, hints ─────────────
//
// Three small tables the Compliance Center writes for itself:
//
//   compliance_finding_states        an admin's decision about ONE finding
//                                    (acknowledged / accepted risk / snoozed).
//                                    compliance_checks stays the truth; this
//                                    only hides a finding from the attention
//                                    list and the counts while its fingerprint
//                                    (status + a stable evidence subset) is
//                                    unchanged. A worse finding re-opens.
//   compliance_subject_registrations the processing record an admin keeps for
//                                    a subject that has no register of its own
//                                    (a collaborative project): purpose, lawful
//                                    basis, retention. Read by
//                                    GDPR-Art30-project-personal-data and the
//                                    RoPA builder.
//   project_hint_dismissals          per person, per project: the one end-user
//                                    hint they dismissed (until its fingerprint
//                                    changes) or snoozed (until a date). On the
//                                    server so it follows them across devices.
const FINDING_STATES = Object.freeze(['acknowledged', 'accepted_risk', 'snoozed']);

const FINDING_DDL = [
    `CREATE TABLE IF NOT EXISTS compliance_finding_states (
        organization_id TEXT NOT NULL,
        check_id        TEXT NOT NULL,
        scope_key       TEXT NOT NULL,
        fingerprint     TEXT NOT NULL,
        state           TEXT NOT NULL
                        CHECK (state IN ('acknowledged', 'accepted_risk', 'snoozed')),
        reason          TEXT,
        until           TIMESTAMPTZ,
        actor_id        TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id, check_id, scope_key)
    )`,
    `CREATE TABLE IF NOT EXISTS compliance_subject_registrations (
        organization_id TEXT NOT NULL,
        subject_kind    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        purpose         TEXT,
        lawful_basis    TEXT,
        retention_days  INTEGER,
        confirmed_by    TEXT,
        confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id, subject_kind, subject_id)
    )`,
    `CREATE TABLE IF NOT EXISTS project_hint_dismissals (
        user_id        TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        hint_key       TEXT NOT NULL,
        fingerprint    TEXT,
        snoozed_until  TIMESTAMPTZ,
        dismissed_at   TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, project_id, hint_key)
    )`,
];

// ───────────────────────── Settings ─────────────────────────
//
// SETTINGS_FIELDS drives saveSettings, getSettings and the additive DDL. One
// entry per writable column:
//   col      column name (= the patch key = the response key)
//   kind     'text' | 'jsonb' | 'int' | 'bool' | 'ts' | 'date' — decides the
//            bind cast (jsonb gets `::jsonb`) and the read-side parsing
//   fallback value when neither the patch nor the stored row has one
//   legacy   the 12 pre-redesign fields: their DDL lives in CREATE TABLE /
//            the v2-v3 ALTERs above, and their merge rule is `??` fall-through
//            (an explicit null in the patch keeps the stored value — the old
//            hand-written UPDATE could not clear a column and the wizard
//            relies on that; pinned by complianceStore.settings.test.js)
//   ddl      column type for the ADD COLUMN IF NOT EXISTS of the new fields
//   min/max  the DOMAIN of an `int` column, checked by the request boundary
//            below. Every int here is an int4: a value past ±2147483647 is not
//            a bad field but a REJECTED UPDATE, with every other edit of the
//            same submit lost. The bound is per column and defensible on that
//            column's own terms — see the rationale at each entry
//   owner    the ONE module that may set this column. The column stays here
//            (its DDL, its merge rule and its read shape are the same as any
//            other), but `sanitizeSettingsPatch` drops it from an untrusted
//            REQUEST body — see SETTINGS_REQUEST_DENY below
//
// New (non-legacy) fields distinguish "absent" from "null": `undefined` keeps
// the stored value, an explicit `null` clears the column (to its fallback for
// jsonb/bool). Frameworks and attestation stamps must be clearable — a NIS2
// registration reference that was entered by mistake has to come out again.
//
// Columns written by their own function (scc_confirmed_operators,
// ropa_reviewed_*, last_retention_run_at) are deliberately NOT here: a PUT
// /settings body must not be able to forge an attestation stamp. Four columns
// DO need an entry here — the framework state and the content-marking stamp
// are read back through getSettings and need their DDL — but they belong to
// one writer all the same, so they carry `owner` and never come from a body.
const SETTINGS_FIELDS = [
    // ── legacy 12 (v1–v3) ──
    { col: 'dpo_name', kind: 'text', legacy: true },
    { col: 'dpo_email', kind: 'text', legacy: true },
    { col: 'dpo_phone', kind: 'text', legacy: true },
    { col: 'legal_bases', kind: 'jsonb', fallback: [], legacy: true },
    { col: 'data_residency', kind: 'text', fallback: 'eu', legacy: true },
    { col: 'breach_recipients', kind: 'jsonb', fallback: [], legacy: true },
    // 0 … 36 500 days. This is how long stored memories are kept (read by the
    // GDPR Art. 5(1)(e) storage-limitation check): a retention period cannot be
    // negative, and 100 years outlives the longest statutory retention an EU
    // organisation can face (decades, for pension and occupational-health
    // records). Past that it is a typo or a paste, never a policy.
    { col: 'default_retention_days', kind: 'int', legacy: true, min: 0, max: 36500 },
    // Whether jobs/memoryRetentionEnforcer.js actually SWEEPS stored memories
    // on default_retention_days. Read there as `=== true`: deleting defaults
    // OFF, so a window that has been on file as documentation for years does
    // not start expiring memories the day the sweep learned to work.
    { col: 'memory_retention_enabled', kind: 'bool', fallback: false, ddl: `BOOLEAN NOT NULL DEFAULT false` },
    // How many days a registered processing may stand before someone has
    // to read it again. 180 when unset (the check's own default).
    { col: 'datatable_review_days', kind: 'int', ddl: `INTEGER`, min: 30, max: 3650 },
    // How long a collaborative project may sit untouched while it still holds
    // personal data (GDPR-Art5-1-e-project-retention). 365 when unset, which
    // the check states in its details. 30 … 3 650: a month is the shortest
    // window that is not a typo for "delete everything", ten years the
    // longest a project workspace is plausibly kept for.
    { col: 'project_retention_days', kind: 'int', ddl: `INTEGER`, min: 30, max: 3650 },
    // Whether project owners and editors see the one gentle, dismissible
    // compliance hint in their project (routes/projects/complianceHints.js).
    // On by default: the hint only ever names something the reader can fix.
    { col: 'project_owner_hints_enabled', kind: 'bool', fallback: true, ddl: `BOOLEAN NOT NULL DEFAULT true` },
    { col: 'privacy_notice_url', kind: 'text', legacy: true },
    { col: 'onboarded_at', kind: 'ts', legacy: true },
    { col: 'ai_literacy_confirmed_at', kind: 'ts', legacy: true },
    { col: 'ai_literacy_material_url', kind: 'text', legacy: true },
    // ── frameworks as a growing set (read by compliance/frameworkPolicy.js) ──
    { col: 'enabled_frameworks', kind: 'jsonb', fallback: [], ddl: `JSONB DEFAULT '[]'::jsonb`, owner: 'compliance/frameworkPolicy' },
    { col: 'framework_relevance', kind: 'jsonb', fallback: {}, ddl: `JSONB DEFAULT '{}'::jsonb`, owner: 'compliance/frameworkPolicy' },
    // ── AI Act Art. 50(2) content marking ──
    { col: 'ai_content_marking_enabled', kind: 'bool', fallback: false, ddl: `BOOLEAN NOT NULL DEFAULT false` },
    { col: 'ai_content_marking_footer', kind: 'text', ddl: `TEXT` },
    { col: 'ai_content_marking_enabled_at', kind: 'ts', ddl: `TIMESTAMPTZ`, owner: 'routes/compliance/settings' },
    { col: 'ai_content_marking_enabled_by', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/settings' },
    // ── platform facts the URL-probing checks need ──
    { col: 'public_base_url', kind: 'text', ddl: `TEXT` },
    { col: 'sso_enforces_mfa', kind: 'bool', ddl: `BOOLEAN` },
    // ── NIS2 ──
    { col: 'nis2_entity_class', kind: 'text', ddl: `TEXT` },
    { col: 'nis2_registration_reference', kind: 'text', ddl: `TEXT` },
    { col: 'nis2_registered_at', kind: 'ts', ddl: `TIMESTAMPTZ` },
    { col: 'nis2_authority_channel', kind: 'text', ddl: `TEXT` },
    { col: 'nis2_csirt_contact', kind: 'text', ddl: `TEXT` },
    { col: 'nis2_board_training_at', kind: 'ts', ddl: `TIMESTAMPTZ` },
    // ── CRA / PLD ──
    { col: 'cra_role', kind: 'text', ddl: `TEXT` },
    { col: 'cra_reporting_channel', kind: 'text', ddl: `TEXT` },
    { col: 'psirt_contact_email', kind: 'text', ddl: `TEXT` },
    { col: 'vuln_disclosure_url', kind: 'text', ddl: `TEXT` },
    { col: 'security_txt_policy_enabled', kind: 'bool', ddl: `BOOLEAN` },
    { col: 'support_policy_url', kind: 'text', ddl: `TEXT` },
    { col: 'support_end_date', kind: 'date', ddl: `DATE` },
    { col: 'security_update_channel', kind: 'text', ddl: `TEXT` },
    // ── Data Act ──
    { col: 'data_act_provider_role', kind: 'bool', ddl: `BOOLEAN` },
    // 0 … 3 650 days. A switching notice period: Data Act Art. 25(2)(d) caps it
    // at two months and checks/data-act/art25-notice-period.js fails anything
    // over 60, so ten years of slack lets an org declare even a bad contract
    // term honestly (and be marked non-compliant for it) without leaving the
    // domain. 0 means "no notice required".
    { col: 'notice_period_days', kind: 'int', ddl: `INTEGER`, min: 0, max: 3650 },
    { col: 'exit_procedure_tested_at', kind: 'ts', ddl: `TIMESTAMPTZ` },
    { col: 'exit_procedure_tested_by', kind: 'text', ddl: `TEXT` },
    // ── EAA ──
    { col: 'accessibility_statement_url', kind: 'text', ddl: `TEXT` },
    { col: 'accessibility_conformance_level', kind: 'text', ddl: `TEXT` },
    { col: 'accessibility_conformance_at', kind: 'ts', ddl: `TIMESTAMPTZ` },
    // ── DORA ──
    { col: 'incident_customer_contacts', kind: 'jsonb', fallback: [], ddl: `JSONB DEFAULT '[]'::jsonb` },
    // 0 … 8 760 hours (one year). The window in which customers are told about
    // a major ICT incident. DORA's own clocks run in hours — initial report
    // within 4, intermediate at 72, final at one month — so a year is already
    // an order of magnitude past any defensible answer; 0 means "immediately".
    { col: 'dora_customer_notice_hours', kind: 'int', fallback: 4, ddl: `INTEGER DEFAULT 4`, min: 0, max: 8760 },
    { col: 'dora_contract_clauses_confirmed_at', kind: 'ts', ddl: `TIMESTAMPTZ` },
    { col: 'dora_contract_clauses_confirmed_by', kind: 'text', ddl: `TEXT` },
    { col: 'dora_contract_template_url', kind: 'text', ddl: `TEXT` },
    // ── Machinery ──
    { col: 'machinery_manual_subjects', kind: 'jsonb', fallback: [], ddl: `JSONB DEFAULT '[]'::jsonb` },
];

// Read-only columns that still belong to the settings shape (own writers).
const SETTINGS_READONLY = [
    { col: 'scc_confirmed_operators', kind: 'jsonb', fallback: [] },
    { col: 'ropa_reviewed_at', kind: 'ts' },
    { col: 'ropa_reviewed_by', kind: 'text' },
    { col: 'last_retention_run_at', kind: 'ts' },
];

// Columns a REQUEST body may never write, even though saveSettings can — each
// belongs to a writer that does more than set the column:
//   enabled_frameworks / framework_relevance → compliance/frameworkPolicy.js
//     checks the per-framework LICENCE (FrameworkLockedError), emits
//     FRAMEWORK_ENABLED / FRAMEWORK_RELEVANCE_CHANGED, busts the policy and
//     counts memos, and keeps the `framework_relevance.meta[id]` audit trail
//     (who/when/why) a whole-object overwrite would silently wipe.
//   ai_content_marking_enabled_at / _by → routes/compliance/settings.js
//     stamps the AI Act Art. 50(2) attestation itself, only when the decision
//     actually changed, together with its evidence row and its event.
// Straight through a PUT body these are a forged attestation and a licence
// bypass respectively, so sanitizeSettingsPatch drops them.
const SETTINGS_REQUEST_DENY = Object.freeze(SETTINGS_FIELDS.filter(f => f.owner).map(f => f.col));

const _cloneFallback = (f) => (f.fallback !== undefined ? JSON.parse(JSON.stringify(f.fallback)) : null);

function _emptySettings(orgId) {
    const out = { organization_id: orgId || 'default' };
    for (const f of [...SETTINGS_FIELDS, ...SETTINGS_READONLY]) out[f.col] = _cloneFallback(f);
    return out;
}

/**
 * Normalise a row from the driver: jsonb columns come back parsed by pg, but
 * a text-typed mock, a legacy CSV import or a NULL cell must still yield the
 * declared shape (array/object), never `null` or a string the UI has to guard.
 */
function _parseSettingsRow(row) {
    const out = { ...row };
    for (const f of [...SETTINGS_FIELDS, ...SETTINGS_READONLY]) {
        if (f.kind !== 'jsonb') continue;
        let v = out[f.col];
        if (typeof v === 'string') {
            try { v = JSON.parse(v); } catch { v = undefined; }
        }
        const wantArray = Array.isArray(f.fallback);
        const ok = v != null && (wantArray ? Array.isArray(v) : (typeof v === 'object' && !Array.isArray(v)));
        out[f.col] = ok ? v : _cloneFallback(f);
    }
    return out;
}

async function getSettings(orgId) {
    await initDB();
    const row = await getOne(`SELECT * FROM compliance_settings WHERE organization_id = $1`, [orgId || 'default']);
    if (!row) return _emptySettings(orgId);
    return _parseSettingsRow(row);
}

/** Resolve one field's value from the patch + the stored row per the rules above. */
function _mergeField(f, patch, existing) {
    const fallback = _cloneFallback(f);
    let v;
    if (f.legacy) {
        v = patch[f.col] ?? existing?.[f.col] ?? fallback;
    } else if (Object.prototype.hasOwnProperty.call(patch, f.col) && patch[f.col] !== undefined) {
        v = patch[f.col] === null ? fallback : patch[f.col];
    } else {
        v = existing?.[f.col] ?? fallback;
    }
    return f.kind === 'jsonb' ? JSON.stringify(v) : v;
}

const _bindCast = (f) => (f.kind === 'jsonb' ? '::jsonb' : '');

// ── the request boundary ─────────────────────────────────────────────────
//
// saveSettings binds every value straight into a typed column, so a body with
// `{"support_end_date":"soon"}` makes Postgres reject the WHOLE update and the
// other 30 fields of the same submit are lost. Values from a request are
// therefore coerced to their declared kind first, and one bad field is a 400
// naming that field instead of a driver error.
//
// The TYPE is not the whole contract. A value can genuinely BE an integer, a
// timestamp or a JSON array and still be one Postgres refuses — same wound,
// same lost submit, so the same 400 covers the column's DOMAIN too. Each of
// these was reproduced against Postgres 17 through the pg driver:
//   · int columns are int4 → 99999999999 is "integer out of range";
//   · a year outside four digits → date '0000-01-01' is "date/time field value
//     out of range" (the calendar Postgres implements has no year zero) and
//     JS's extended-year ISO form, which `new Date()` accepts and
//     `toISOString()` round-trips, is "time zone displacement out of range";
//   · U+0000 → a text bind is 'invalid byte sequence for encoding "UTF8":
//     0x00' and a jsonb bind is "unsupported Unicode escape sequence", because
//     that escape cannot be converted to text.
// One more is not Postgres but the same visible failure: a jsonb value nested
// thousands deep makes JSON.stringify (in _mergeField, before any SQL) throw
// "Maximum call stack size exceeded" — a 500 with a raw runtime message and
// the whole submit gone. It is refused here as well, and the walk that finds
// it is iterative so it cannot fall over the same way.
//
// What is deliberately NOT bounded here, having been checked:
//   · text LENGTH. compliance_settings has no varchar and no index on a
//     body-writable column (only the PK on organization_id), so `text` is
//     unbounded up to 1 GB: a long value is a body-size question, which
//     bodyParser's limit answers, not a value Postgres rejects.
//   · jsonb ELEMENT SHAPE (a list of objects where the reader wants strings).
//     jsonb takes it happily, so it cannot lose a save; it is the consumer's
//     contract, enforced where that consumer reads it.
//   · booleans, which already admit only true/false and their two strings.

const _isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

// A column that forgets to declare min/max still cannot overflow its int4.
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

// The four-digit ISO year window. Postgres itself reaches from 4713 BC to
// 294276 AD, but nothing outside `YYYY` is both storable and plausible here:
// every ts/date column in this table is an attestation moment, a registration
// date or a support end date.
const MIN_YEAR = 1900;
const MAX_YEAR = 9999;

// jsonb nesting. These columns hold flat lists and one-level records, so 20 is
// far past any real shape — and far below the ~4 000 at which JSON.stringify
// blows its own stack.
const MAX_JSON_DEPTH = 20;

const NUL = String.fromCharCode(0); // U+0000, never a literal in source

const _yearInRange = (d) => d.getUTCFullYear() >= MIN_YEAR && d.getUTCFullYear() <= MAX_YEAR;

/**
 * Walk a JSON-shaped value for the two things a jsonb column cannot take.
 * Iterative on purpose: a pathological body must not overflow the stack HERE
 * either. Object keys are checked as well as values — a NUL in a key is just
 * as fatal to the bind.
 * @returns {null | 'nul' | 'depth'}
 */
function _jsonDefect(root) {
    const stack = [[root, 0]];
    while (stack.length) {
        const [v, depth] = stack.pop();
        if (typeof v === 'string') {
            if (v.includes(NUL)) return 'nul';
            continue;
        }
        if (v === null || typeof v !== 'object') continue;
        if (depth > MAX_JSON_DEPTH) return 'depth';
        if (Array.isArray(v)) {
            for (const x of v) stack.push([x, depth + 1]);
            continue;
        }
        for (const [k, x] of Object.entries(v)) {
            if (k.includes(NUL)) return 'nul';
            stack.push([x, depth + 1]);
        }
    }
    return null;
}

/**
 * Coerce one request value to its column's declared kind AND domain.
 * @returns {{ok: true, value: any} | {ok: false, expected: string}}
 */
function _coerceSettingValue(f, v) {
    if (v === null) return { ok: true, value: null };
    switch (f.kind) {
        case 'jsonb': {
            // A JSON *string* would be double-encoded by the `::jsonb` bind,
            // so only the declared shape is accepted.
            const wantArray = Array.isArray(f.fallback);
            const shape = wantArray ? 'a JSON array' : 'a JSON object';
            if (wantArray ? !Array.isArray(v) : !_isPlainObject(v)) return { ok: false, expected: shape };
            const defect = _jsonDefect(v);
            if (defect === 'nul') return { ok: false, expected: `${shape} without NUL characters` };
            if (defect === 'depth') return { ok: false, expected: `${shape} nested at most ${MAX_JSON_DEPTH} levels deep` };
            return { ok: true, value: v };
        }
        case 'int': {
            let n = null;
            if (typeof v === 'number' && Number.isInteger(v)) n = v;
            else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) n = Number(v.trim());
            if (n === null) return { ok: false, expected: 'an integer' };
            // The column's own domain (min/max in SETTINGS_FIELDS). A long
            // digit string parses to Infinity, which fails this the same way.
            const min = Number.isInteger(f.min) ? f.min : INT4_MIN;
            const max = Number.isInteger(f.max) ? f.max : INT4_MAX;
            if (!(n >= min && n <= max)) return { ok: false, expected: `an integer between ${min} and ${max}` };
            return { ok: true, value: n };
        }
        case 'bool': {
            if (typeof v === 'boolean') return { ok: true, value: v };
            if (v === 'true') return { ok: true, value: true };
            if (v === 'false') return { ok: true, value: false };
            return { ok: false, expected: 'a boolean' };
        }
        case 'ts': {
            const d = v instanceof Date ? v : (typeof v === 'string' ? new Date(v) : null);
            if (!d || Number.isNaN(d.getTime())) return { ok: false, expected: 'an ISO-8601 timestamp' };
            if (!_yearInRange(d)) return { ok: false, expected: `an ISO-8601 timestamp in the years ${MIN_YEAR}-${MAX_YEAR}` };
            return { ok: true, value: d.toISOString() };
        }
        case 'date': {
            const strict = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
            const d = strict
                ? new Date(`${strict}T00:00:00Z`)
                : (v instanceof Date ? v : (typeof v === 'string' ? new Date(v) : null));
            if (!d || Number.isNaN(d.getTime())) return { ok: false, expected: 'a date (YYYY-MM-DD)' };
            // JS rolls 2029-02-31 over to March; Postgres rejects it.
            if (strict && d.toISOString().slice(0, 10) !== strict) return { ok: false, expected: 'a date (YYYY-MM-DD)' };
            // The year check also guarantees toISOString() renders a plain
            // four-digit year — an extended year would slice to garbage.
            if (!_yearInRange(d)) return { ok: false, expected: `a date (YYYY-MM-DD) in the years ${MIN_YEAR}-${MAX_YEAR}` };
            return { ok: true, value: d.toISOString().slice(0, 10) };
        }
        default: {
            let s = null;
            if (typeof v === 'string') s = v;
            else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
            else if (typeof v === 'boolean') s = String(v);
            if (s === null) return { ok: false, expected: 'a string' };
            if (s.includes(NUL)) return { ok: false, expected: 'a string without NUL characters' };
            return { ok: true, value: s };
        }
    }
}

/**
 * 400 for a settings body. Carries the FIELD NAMES and the expected type or
 * range and nothing else — a settings value can be personal data (a DPO name,
 * a breach recipient's address), so it is never echoed back or logged
 * (BFSF-441). A range is named, never the value that missed it.
 */
class SettingsValidationError extends Error {
    /** @param {{field: string, expected: string}[]} fields */
    constructor(fields) {
        super(`Invalid settings value for: ${fields.map(f => f.field).join(', ')}`);
        this.name = 'SettingsValidationError';
        this.code = 'invalid_setting';
        this.status = 400;
        this.fields = fields;
        this.body = { error: 'invalid_setting', fields };
    }
}

/**
 * Turn an untrusted request body into a saveSettings patch:
 *   · keys outside SETTINGS_FIELDS are dropped (as saveSettings already does);
 *   · the owner-written columns (SETTINGS_REQUEST_DENY) are dropped, so a body
 *     can neither forge an attestation stamp nor switch a licensed framework
 *     on behind frameworkPolicy's back — a client that wants those uses their
 *     own route, and a whole-row round-trip PUT stays harmless;
 *   · every remaining value is coerced to its declared column type AND held to
 *     that column's domain (its int range, a storable year, no NUL), because a
 *     value Postgres refuses costs the caller the whole submit, not one field.
 * Absent keys and `undefined` stay absent, so the absent/null distinction the
 * merge rules depend on survives.
 * @throws {SettingsValidationError} when any value does not fit its column
 */
function sanitizeSettingsPatch(body) {
    const src = body && typeof body === 'object' ? body : {};
    const out = {};
    const bad = [];
    for (const f of SETTINGS_FIELDS) {
        if (f.owner) continue;
        if (!Object.prototype.hasOwnProperty.call(src, f.col)) continue;
        const v = src[f.col];
        if (v === undefined) continue;
        const r = _coerceSettingValue(f, v);
        if (r.ok) out[f.col] = r.value;
        else bad.push({ field: f.col, expected: /** @type {{expected: string}} */ (r).expected });
    }
    if (bad.length) throw new SettingsValidationError(bad);
    return out;
}

/**
 * Whitelisted, merge-on-write update of the settings row. Unknown keys in
 * `patch` are dropped; SETTINGS_FIELDS is the only source of the column list,
 * so adding a field is one entry there (DDL + write + read follow).
 */
async function saveSettings(orgId, patch) {
    await initDB();
    const p = patch || {};
    const existing = await getOne(`SELECT * FROM compliance_settings WHERE organization_id = $1`, [orgId]);
    const values = SETTINGS_FIELDS.map(f => _mergeField(f, p, existing));
    if (existing) {
        const assignments = SETTINGS_FIELDS.map((f, i) => `${f.col} = $${i + 2}${_bindCast(f)}`);
        await run(`
            UPDATE compliance_settings SET
                ${assignments.join(',\n                ')},
                updated_at = NOW()
            WHERE organization_id = $1
        `, [orgId, ...values]);
    } else {
        const cols = SETTINGS_FIELDS.map(f => f.col);
        const binds = SETTINGS_FIELDS.map((f, i) => `$${i + 2}${_bindCast(f)}`);
        await run(`
            INSERT INTO compliance_settings
                (organization_id, ${cols.join(', ')})
            VALUES ($1, ${binds.join(', ')})
        `, [orgId, ...values]);
    }
    return getSettings(orgId);
}

async function markOnboarded(orgId) {
    await initDB();
    await run(`
        UPDATE compliance_settings SET onboarded_at = NOW(), updated_at = NOW()
        WHERE organization_id = $1 AND onboarded_at IS NULL
    `, [orgId]);
}

// ───────────────────────── SCC attestation ─────────────────────────
//
// Admins confirm that Standard Contractual Clauses are in place for a given
// processor (operator name as it appears in integration_activity_log.operator).
// Each entry stores who attested and when so it is auditable via the evidence
// chain. Removing an operator does NOT delete prior evidence rows.

async function setSccConfirmed(orgId, operator, confirmed, attestedBy) {
    await initDB();
    const existing = await getSettings(orgId);
    const list = Array.isArray(existing.scc_confirmed_operators) ? existing.scc_confirmed_operators : [];
    const filtered = list.filter(e => (e?.operator || '').toLowerCase() !== String(operator).toLowerCase());
    const next = confirmed
        // Keep the DORA register-of-information fields (contract_ref, critical,
        // country) a previous attestation may carry — re-confirming SCC must
        // not silently drop them (CHECK-CATALOGUE §2.6).
        ? [...filtered, {
            ...(list.find(e => (e?.operator || '').toLowerCase() === String(operator).toLowerCase()) || {}),
            operator, attested_by: attestedBy || null, attested_at: new Date().toISOString(),
        }]
        : filtered;
    await run(`
        INSERT INTO compliance_settings (organization_id, scc_confirmed_operators, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET scc_confirmed_operators = EXCLUDED.scc_confirmed_operators, updated_at = NOW()
    `, [orgId, JSON.stringify(next)]);
    return next;
}

// ───────────────────────── RoPA review ─────────────────────────

async function markRopaReviewed(orgId, reviewerId) {
    await initDB();
    await run(`
        INSERT INTO compliance_settings (organization_id, ropa_reviewed_at, ropa_reviewed_by, updated_at)
        VALUES ($1, NOW(), $2, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET ropa_reviewed_at = NOW(), ropa_reviewed_by = $2, updated_at = NOW()
    `, [orgId, reviewerId || null]);
}

// ───────────────────────── Retention enforcer heartbeat ─────────────────────────

async function markRetentionRun(orgId) {
    await initDB();
    await run(`
        INSERT INTO compliance_settings (organization_id, last_retention_run_at, updated_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET last_retention_run_at = NOW(), updated_at = NOW()
    `, [orgId]);
}

// ───────────────────────── Check results ─────────────────────────

async function recordCheckResult(row) {
    await initDB();
    await run(`
        INSERT INTO compliance_checks
            (organization_id, check_id, regulation, article, severity, status,
             evidence, details, scope_type, scope_id, run_type, framework_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
    `, [
        row.organization_id || null,
        row.check_id,
        row.regulation,
        row.article || null,
        row.severity || 'medium',
        row.status,
        JSON.stringify(row.evidence || {}),
        row.details || null,
        row.scope_type || 'global',
        row.scope_id || null,
        row.run_type || 'scheduled',
        row.framework_code || null,
    ]);
}

async function getLatestPerCheck(orgId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (check_id, scope_type, scope_id)
            check_id, regulation, article, severity, status, evidence, details,
            scope_type, scope_id, run_at, run_type, framework_code
        FROM compliance_checks
        WHERE organization_id = $1
        ORDER BY check_id, scope_type, scope_id, run_at DESC
    `, [orgId]);
}

/**
 * The newest row of every slot ONE check has ever written for an org —
 * `{scope_type, scope_id, status, evidence, run_at}`. The runner reads it after
 * a full sweep to retire the per-source subjects `listSubjects` stopped
 * returning (a deleted project must not keep its last warning forever).
 * Served by idx_compliance_checks_latest.
 */
async function listLatestScopes(orgId, checkId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (scope_type, scope_id)
            scope_type, scope_id, status, evidence, run_at
        FROM compliance_checks
        WHERE organization_id = $1 AND check_id = $2
        ORDER BY scope_type, scope_id, run_at DESC
    `, [orgId, checkId]);
}

/**
 * The newest row per slot of the NAMED checks only — the targeted read the
 * end-user hint API makes instead of the org-wide getLatestPerCheck. Rows
 * older than `maxAgeDays` are left out: a check that stopped running (its
 * framework was switched off) must not keep feeding a hint.
 */
async function getLatestForChecks(orgId, checkIds, { maxAgeDays = 3 } = {}) {
    await initDB();
    const ids = (Array.isArray(checkIds) ? checkIds : []).map(String).filter(Boolean);
    if (!ids.length) return [];
    return getAll(`
        SELECT DISTINCT ON (check_id, scope_type, scope_id)
            check_id, status, evidence, scope_type, scope_id, run_at
        FROM compliance_checks
        WHERE organization_id = $1 AND check_id = ANY($2::text[])
          AND run_at >= NOW() - ($3 || ' days')::interval
        ORDER BY check_id, scope_type, scope_id, run_at DESC
    `, [orgId, ids, String(Math.max(1, Math.trunc(Number(maxAgeDays) || 3)))]);
}

/**
 * One check's result rows, newest first. `scopeId` narrows them to one
 * subject's slot (a per-source check has a row per agent or automation, and
 * one row's audit trail must not show another subject's runs). Without it
 * every slot is returned, as before.
 *
 * @param {string} orgId
 * @param {string} checkId
 * @param {number} [limit]
 * @param {{ scopeId?: string | null }} [opts]
 */
async function getCheckHistory(orgId, checkId, limit = 100, { scopeId } = {}) {
    await initDB();
    const scoped = typeof scopeId === 'string' && scopeId !== '';
    return getAll(`
        SELECT status, details, run_at, run_type, evidence, scope_type, scope_id, framework_code
        FROM compliance_checks
        WHERE organization_id = $1 AND check_id = $2
        ${scoped ? 'AND scope_id IS NOT DISTINCT FROM $4' : ''}
        ORDER BY run_at DESC
        LIMIT $3
    `, scoped ? [orgId, checkId, limit, scopeId] : [orgId, checkId, limit]);
}

// ───────────────────────── Score history ─────────────────────────

// Legacy column ↔ framework id. The three original frameworks keep their
// columns so old sparkline consumers keep working; `scores` carries them too.
const LEGACY_SCORE_COLUMNS = { gdpr_score: 'gdpr', aia_score: 'aia', iso_score: 'iso27001' };

function _scoresObject(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * @param {object} row  organization_id, overall_score, pass/warn/fail/na,
 *   run_type, the legacy gdpr_score/aia_score/iso_score and/or `scores`
 *   ({<framework_id>: number|null}), and `coverage` — what the number was
 *   computed over. Either score side fills the other when only one is given,
 *   so a runner that passes just `scores` still lands the legacy columns and
 *   vice versa. A caller that passes no `coverage` stores NULL: the row then
 *   says the sweep did not record its coverage, which is not the same claim
 *   as "it covered everything" and must never be rendered as one.
 */
async function recordScoreSnapshot(row) {
    await initDB();
    const scores = { ..._scoresObject(row.scores) };
    const legacy = {};
    for (const [col, fw] of Object.entries(LEGACY_SCORE_COLUMNS)) {
        legacy[col] = row[col] ?? scores[fw] ?? null;
        if (scores[fw] === undefined && row[col] != null) scores[fw] = row[col];
    }
    await run(`
        INSERT INTO compliance_score_history
            (organization_id, overall_score, gdpr_score, aia_score, iso_score, pass, warn, fail, na, run_type, scores, coverage)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
    `, [
        row.organization_id || 'default',
        row.overall_score ?? null,
        legacy.gdpr_score,
        legacy.aia_score,
        legacy.iso_score,
        row.pass ?? null, row.warn ?? null, row.fail ?? null, row.na ?? null,
        row.run_type || 'scheduled',
        JSON.stringify(scores),
        row.coverage == null ? null : JSON.stringify(row.coverage),
    ]);
}

/**
 * Snapshots of the last `days` days, oldest first. `scores` is always an
 * object: rows written before the column (or with an empty one) get
 * {gdpr, aia, iso27001} synthesised from the legacy columns on the way out —
 * read path only, the stored row is never rewritten.
 *
 * `coverage` is NOT synthesised. A row from before the column has no record of
 * what its score covered, and the honest value for that is `null`; inventing a
 * "fully covered" default for old rows would re-tell exactly the lie the
 * column was added to stop (compliance/runner.js, COVERAGE).
 */
async function getScoreHistory(orgId, days = 90) {
    await initDB();
    const rows = await getAll(`
        SELECT overall_score, gdpr_score, aia_score, iso_score, pass, warn, fail, na, run_type, captured_at, scores, coverage
        FROM compliance_score_history
        WHERE organization_id = $1
          AND captured_at >= NOW() - ($2 || ' days')::interval
        ORDER BY captured_at ASC
    `, [orgId, String(days)]);
    return rows.map(r => {
        const stored = _scoresObject(r.scores);
        const scores = Object.keys(stored).length > 0
            ? stored
            : Object.fromEntries(Object.entries(LEGACY_SCORE_COLUMNS).map(([col, fw]) => [fw, r[col] ?? null]));
        const coverage = typeof r.coverage === 'string'
            ? (() => { try { return JSON.parse(r.coverage); } catch { return null; } })()
            : (r.coverage ?? null);
        return { ...r, scores, coverage };
    });
}

// ───────────────────────── Evidence ─────────────────────────

const EVIDENCE_COLUMNS = 'id, check_id, subject_type, subject_id, captured_at, hash, payload, storage_key, seq, prev_hash, payload_hash';

/**
 * Append one evidence row as the next link of the org's hash chain.
 *
 *   payload_hash = sha256(canonicalJSON(payload))            (chain.hashPayload)
 *   hash         = sha256(prev_hash ∥ payload_hash)          (chain.linkHash)
 *   seq          = head.seq + 1  (genesis: seq 1, prev_hash NULL)
 *
 * Runs in one transaction under a per-org advisory lock, so two concurrent
 * writers cannot both read the same head; the partial unique index on
 * (organization_id, seq) is the backstop.
 *
 * Caller-supplied `row.hash` — the file sha256 of an upload, the SoA/RoPA
 * export digest, the runner's own JSON.stringify hash — is NOT the chain
 * hash any more. It is folded into `payload.sha256` when the payload has no
 * `sha256` of its own, so the nine pre-chain call sites keep their digest
 * (now inside the canonical payload, hence covered by payload_hash) without
 * changing a line. `hash` on the row is always the link hash.
 *
 * Rows without an organization_id are stored unchained (seq NULL) — the
 * chain is per org and there is no org to lock on.
 *
 * @returns {Promise<{id:number, seq:number|null, hash:string}>}
 */
async function addEvidence(row) {
    await initDB();
    const chain = require('../compliance/evidence/chain');
    const orgId = row.organization_id || null;
    const payload = { ...(row.payload || {}) };
    if (row.hash && payload.sha256 === undefined) payload.sha256 = row.hash;
    const payloadHash = chain.hashPayload(payload);
    const common = [
        row.check_id || null,
        row.subject_type || null,
        row.subject_id || null,
        JSON.stringify(payload),
        row.storage_key || null,
        payloadHash,
    ];

    if (orgId === null) {
        const { rows } = await run(`
            INSERT INTO compliance_evidence
                (organization_id, check_id, subject_type, subject_id, payload, storage_key, payload_hash, hash)
            VALUES (NULL, $1, $2, $3, $4::jsonb, $5, $6, $7)
            RETURNING id, seq, hash
        `, [...common, chain.linkHash(null, payloadHash)]);
        return rows[0];
    }

    return withTransaction(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('beeflow:evidence:' || $1))`, [orgId]);
        const head = await client.query(`
            SELECT seq, hash FROM compliance_evidence
            WHERE organization_id = $1 AND seq IS NOT NULL
            ORDER BY seq DESC
            LIMIT 1
        `, [orgId]);
        const prev = head.rows[0] || null;
        const prevHash = prev ? prev.hash : null;
        const seq = prev ? Number(prev.seq) + 1 : 1;
        const hash = chain.linkHash(prevHash, payloadHash);
        const { rows } = await client.query(`
            INSERT INTO compliance_evidence
                (organization_id, check_id, subject_type, subject_id, payload, storage_key, payload_hash,
                 seq, prev_hash, hash)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
            RETURNING id, seq, hash
        `, [orgId, ...common, seq, prevHash, hash]);
        const out = rows[0] || { id: null, seq, hash };
        return { id: out.id, seq: out.seq != null ? Number(out.seq) : seq, hash: out.hash || hash };
    });
}

/** Newest chained link of an org — `{seq, hash}` or null when nothing is chained yet. */
async function getChainHead(orgId) {
    await initDB();
    const row = await getOne(`
        SELECT seq, hash FROM compliance_evidence
        WHERE organization_id = $1 AND seq IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1
    `, [orgId]);
    return row ? { seq: Number(row.seq), hash: row.hash } : null;
}

/**
 * Filters shared by listEvidence/countEvidence. `regulation` matches the
 * check-id prefix (`GDPR-…`, `DATA_ACT-…`) — evidence rows carry no
 * regulation column of their own.
 * @param orgId
 * @param {{ checkId?: string, subjectType?: string, subjectId?: string, regulation?: string }} [opts]
 */
function _evidenceWhere(orgId, { checkId, subjectType, subjectId, regulation } = {}) {
    const params = [orgId];
    const where = ['organization_id = $1'];
    if (checkId) { params.push(checkId); where.push(`check_id = $${params.length}`); }
    if (subjectType) { params.push(subjectType); where.push(`subject_type = $${params.length}`); }
    if (subjectId) { params.push(String(subjectId)); where.push(`subject_id = $${params.length}`); }
    if (regulation) {
        params.push(`${String(regulation).replace(/[%_\\]/g, '\\$&')}-%`);
        where.push(`check_id LIKE $${params.length}`);
    }
    return { params, where: where.join(' AND ') };
}

/**
 * @param orgId
 * @param {{ checkId?: string, subjectType?: string, subjectId?: string, regulation?: string, limit?: number, offset?: number }} [opts]
 */
async function listEvidence(orgId, { checkId, subjectType, subjectId, regulation, limit = 100, offset = 0 } = {}) {
    await initDB();
    const { params, where } = _evidenceWhere(orgId, { checkId, subjectType, subjectId, regulation });
    params.push(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    const limitIdx = params.length;
    params.push(Math.max(0, Number(offset) || 0));
    return getAll(`
        SELECT ${EVIDENCE_COLUMNS}
        FROM compliance_evidence
        WHERE ${where}
        ORDER BY captured_at DESC, id DESC
        LIMIT $${limitIdx} OFFSET $${params.length}
    `, params);
}

async function countEvidence(orgId, filters = {}) {
    await initDB();
    const { params, where } = _evidenceWhere(orgId, filters);
    const row = await getOne(`SELECT COUNT(*)::int AS n FROM compliance_evidence WHERE ${where}`, params);
    return row ? Number(row.n) || 0 : 0;
}

async function getEvidenceById(orgId, id) {
    await initDB();
    return getOne(`
        SELECT ${EVIDENCE_COLUMNS}
        FROM compliance_evidence
        WHERE organization_id = $1 AND id = $2
    `, [orgId, Number(id)]);
}

async function getEvidenceHistory(orgId, checkId, limit = 100) {
    await initDB();
    return getAll(`
        SELECT ${EVIDENCE_COLUMNS}
        FROM compliance_evidence
        WHERE organization_id = $1 AND check_id = $2
        ORDER BY captured_at DESC
        LIMIT $3
    `, [orgId, checkId, limit]);
}

// ───────────────────────── Notifier idempotency ─────────────────────────
//
// The deadline notifier fires tiers (DSR 7 d/1 d/overdue, CRA 24 h/72 h,
// calendar milestones 30/7/0 d, attestation expiries). Each tier is recorded
// once per subject; a sweep that finds the row already there sends nothing.

/** @returns {Promise<boolean>} true when this call inserted the row (= send now). */
async function markNotified(orgId, subjectKind, subjectId, offsetKey) {
    await initDB();
    const r = await run(`
        INSERT INTO compliance_notify_log (organization_id, subject_kind, subject_id, offset_key)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (organization_id, subject_kind, subject_id, offset_key) DO NOTHING
    `, [orgId, String(subjectKind), String(subjectId), String(offsetKey)]);
    return (r?.rowCount || 0) > 0;
}

async function wasNotified(orgId, subjectKind, subjectId, offsetKey) {
    await initDB();
    const row = await getOne(`
        SELECT 1 AS hit FROM compliance_notify_log
        WHERE organization_id = $1 AND subject_kind = $2 AND subject_id = $3 AND offset_key = $4
    `, [orgId, String(subjectKind), String(subjectId), String(offsetKey)]);
    return !!row;
}

// ───────────────────────── Finding states ─────────────────────────

const _iso = (v) => (v == null ? null : new Date(v).toISOString());

function _stateRow(r) {
    if (!r) return null;
    return {
        check_id: r.check_id,
        scope_key: r.scope_key,
        fingerprint: r.fingerprint,
        state: r.state,
        reason: r.reason ?? null,
        until: _iso(r.until),
        actor_id: r.actor_id ?? null,
        created_at: _iso(r.created_at),
        updated_at: _iso(r.updated_at),
    };
}

/** Every recorded decision of an org (a few rows per check at most). */
async function listFindingStates(orgId) {
    await initDB();
    const rows = await getAll(`
        SELECT check_id, scope_key, fingerprint, state, reason, until, actor_id, created_at, updated_at
        FROM compliance_finding_states
        WHERE organization_id = $1
    `, [orgId]);
    return (rows || []).map(_stateRow);
}

/**
 * Record (or replace) the decision about one finding. `scopeKey` is the
 * result row's scope_id, or 'global'. The caller computes the fingerprint
 * (compliance/findingState.js) from the row the admin looked at.
 */
async function setFindingState(orgId, { checkId, scopeKey, fingerprint, state, reason = null, until = null, actorId = null }) {
    await initDB();
    if (!FINDING_STATES.includes(state)) throw new Error(`Unknown finding state: ${state}`);
    const row = await getOne(`
        INSERT INTO compliance_finding_states
            (organization_id, check_id, scope_key, fingerprint, state, reason, until, actor_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (organization_id, check_id, scope_key) DO UPDATE SET
            fingerprint = EXCLUDED.fingerprint,
            state = EXCLUDED.state,
            reason = EXCLUDED.reason,
            until = EXCLUDED.until,
            actor_id = EXCLUDED.actor_id,
            updated_at = NOW()
        RETURNING check_id, scope_key, fingerprint, state, reason, until, actor_id, created_at, updated_at
    `, [orgId, String(checkId), String(scopeKey), String(fingerprint), state, reason, until, actorId]);
    return _stateRow(row);
}

/** Re-open a finding: forget the decision. Returns true when one existed. */
async function clearFindingState(orgId, checkId, scopeKey) {
    await initDB();
    const r = await run(`
        DELETE FROM compliance_finding_states
        WHERE organization_id = $1 AND check_id = $2 AND scope_key = $3
    `, [orgId, String(checkId), String(scopeKey)]);
    return (r?.rowCount || 0) > 0;
}

// ───────────────────────── Subject registrations ─────────────────────────

function _registrationRow(r) {
    if (!r) return null;
    return {
        subject_kind: r.subject_kind,
        subject_id: r.subject_id,
        purpose: r.purpose ?? null,
        lawful_basis: r.lawful_basis ?? null,
        retention_days: r.retention_days == null ? null : Number(r.retention_days),
        confirmed_by: r.confirmed_by ?? null,
        confirmed_at: _iso(r.confirmed_at),
    };
}

/** The org's processing records for one kind of subject ('project'). */
async function listSubjectRegistrations(orgId, subjectKind) {
    await initDB();
    const rows = await getAll(`
        SELECT subject_kind, subject_id, purpose, lawful_basis, retention_days, confirmed_by, confirmed_at
        FROM compliance_subject_registrations
        WHERE organization_id = $1 AND subject_kind = $2
        ORDER BY confirmed_at DESC
    `, [orgId, String(subjectKind)]);
    return (rows || []).map(_registrationRow);
}

/** Record or re-confirm one processing record; confirmed_at moves to NOW(). */
async function upsertSubjectRegistration(orgId, { subjectKind, subjectId, purpose = null, lawfulBasis = null, retentionDays = null, confirmedBy = null }) {
    await initDB();
    const row = await getOne(`
        INSERT INTO compliance_subject_registrations
            (organization_id, subject_kind, subject_id, purpose, lawful_basis, retention_days, confirmed_by, confirmed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (organization_id, subject_kind, subject_id) DO UPDATE SET
            purpose = EXCLUDED.purpose,
            lawful_basis = EXCLUDED.lawful_basis,
            retention_days = EXCLUDED.retention_days,
            confirmed_by = EXCLUDED.confirmed_by,
            confirmed_at = NOW()
        RETURNING subject_kind, subject_id, purpose, lawful_basis, retention_days, confirmed_by, confirmed_at
    `, [orgId, String(subjectKind), String(subjectId), purpose, lawfulBasis, retentionDays, confirmedBy]);
    return _registrationRow(row);
}

async function deleteSubjectRegistration(orgId, subjectKind, subjectId) {
    await initDB();
    const r = await run(`
        DELETE FROM compliance_subject_registrations
        WHERE organization_id = $1 AND subject_kind = $2 AND subject_id = $3
    `, [orgId, String(subjectKind), String(subjectId)]);
    return (r?.rowCount || 0) > 0;
}

// ───────────────────────── End-user hint dismissals ─────────────────────────

/** `{[hintKey]: {fingerprint, snoozedUntil, dismissedAt}}` for one person in one project. */
async function getHintDismissals(userId, projectId) {
    await initDB();
    const rows = await getAll(`
        SELECT hint_key, fingerprint, snoozed_until, dismissed_at
        FROM project_hint_dismissals
        WHERE user_id = $1 AND project_id = $2
    `, [String(userId), String(projectId)]);
    const out = {};
    for (const r of rows || []) {
        out[r.hint_key] = {
            fingerprint: r.fingerprint ?? null,
            snoozedUntil: _iso(r.snoozed_until),
            dismissedAt: _iso(r.dismissed_at),
        };
    }
    return out;
}

/**
 * Dismiss (`snoozedUntil` null) or snooze one hint. A dismissal stores the
 * fingerprint it was made against, so the hint returns only when what it
 * reports changes; a snooze lapses by date whatever the fingerprint.
 */
async function recordHintDismissal(userId, projectId, hintKey, { fingerprint = null, snoozedUntil = null } = {}) {
    await initDB();
    await run(`
        INSERT INTO project_hint_dismissals (user_id, project_id, hint_key, fingerprint, snoozed_until, dismissed_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::timestamptz IS NULL THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (user_id, project_id, hint_key) DO UPDATE SET
            fingerprint = EXCLUDED.fingerprint,
            snoozed_until = EXCLUDED.snoozed_until,
            dismissed_at = EXCLUDED.dismissed_at,
            updated_at = NOW()
    `, [String(userId), String(projectId), String(hintKey), fingerprint, snoozedUntil]);
}

// A table this install never created holds nothing to erase — and erasing a
// person must not create the compliance schema on the way.
async function _deleteHintRows(sql, params) {
    try {
        const r = await run(sql, params);
        return r?.rowCount || 0;
    } catch (e) {
        if (e?.code === '42P01') return 0;
        throw e;
    }
}

/**
 * Account erasure (stores/user/projectErasure.js): every hint this person put
 * away. The rows say which projects they belonged to and when they acted, and
 * a later account that reused the id would inherit their dismissals.
 */
async function eraseHintDismissals(userId) {
    if (!userId) return { rows: 0 };
    const rows = await _deleteHintRows('DELETE FROM project_hint_dismissals WHERE user_id = $1', [String(userId)]);
    return { rows };
}

/**
 * The dismissals whose project or person no longer exists — whatever path
 * removed them (the project's delete route, the cascade that takes an erased
 * owner's projects with them, a directory sync). The table has no foreign key
 * (the compliance schema may be created before the projects table exists), so
 * the compliance sweep runs this once per tick (compliance/scheduler.js).
 */
async function pruneHintDismissals() {
    const rows = await _deleteHintRows(`
        DELETE FROM project_hint_dismissals d
        WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id)
           OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id)
    `, []);
    return { rows };
}

log.info('[ComplianceStore] Initialized (PostgreSQL)');

module.exports = {
    initDB,
    SETTINGS_FIELDS,
    SETTINGS_REQUEST_DENY,
    SettingsValidationError,
    sanitizeSettingsPatch,
    getSettings,
    saveSettings,
    markOnboarded,
    setSccConfirmed,
    markRopaReviewed,
    markRetentionRun,
    recordCheckResult,
    getLatestPerCheck,
    listLatestScopes,
    getLatestForChecks,
    getCheckHistory,
    recordScoreSnapshot,
    getScoreHistory,
    addEvidence,
    getChainHead,
    listEvidence,
    countEvidence,
    getEvidenceById,
    getEvidenceHistory,
    markNotified,
    wasNotified,
    FINDING_STATES,
    listFindingStates,
    setFindingState,
    clearFindingState,
    listSubjectRegistrations,
    upsertSubjectRegistration,
    deleteSubjectRegistration,
    getHintDismissals,
    recordHintDismissal,
    eraseHintDismissals,
    pruneHintDismissals,
};

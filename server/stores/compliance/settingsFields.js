// @typecheck
/**
 * The compliance_settings column table: SETTINGS_FIELDS (writable columns),
 * SETTINGS_READONLY (columns with their own writers) and SETTINGS_REQUEST_DENY
 * (owner-written columns a request body may never set). Pure data: the DDL
 * (schema.js), the merge-on-write (settings.js) and the request boundary
 * (settingsRequest.js) all read it.
 */

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
    // ── Chat signals (checking whether the Privacy Shield works, Art. 32(1)(d)) ──
    // Every column belongs to routes/compliance/chatMonitoring.js, which checks
    // the preconditions (422), the org-admin rule for a widen, stamps, writes
    // evidence and invalidates the resolver. Never from a PUT /settings body.
    // No migration writes them, so a rollback leaves chat signals off.
    { col: 'chat_monitoring_enabled', kind: 'bool', fallback: false, ddl: `BOOLEAN NOT NULL DEFAULT false`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_surfaces', kind: 'jsonb', fallback: [], ddl: `JSONB DEFAULT '[]'::jsonb`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_signals', kind: 'jsonb', fallback: [], ddl: `JSONB DEFAULT '[]'::jsonb`, owner: 'routes/compliance/chatMonitoring' },
    // Its exact ISO value is the notice VERSION the in-chat marker carries.
    { col: 'chat_monitoring_effective_from', kind: 'ts', ddl: `TIMESTAMPTZ`, owner: 'routes/compliance/chatMonitoring' },
    // 30 … 90 days; null reads 90 (amendment 9).
    { col: 'chat_monitoring_retention_days', kind: 'int', ddl: `INTEGER`, min: 30, max: 90, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_legal_basis', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_lia_at', kind: 'ts', ddl: `TIMESTAMPTZ`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_works_council', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_works_council_reason', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_works_council_at', kind: 'date', ddl: `DATE`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_works_council_scope', kind: 'jsonb', fallback: {}, ddl: `JSONB DEFAULT '{}'::jsonb`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_dpia_ref', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_dpia_at', kind: 'date', ddl: `DATE`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_dpia_risk_level', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_dpo_advice_at', kind: 'date', ddl: `DATE`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_prior_consultation_at', kind: 'date', ddl: `DATE`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_notice_url', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_notice_published_at', kind: 'date', ddl: `DATE`, owner: 'routes/compliance/chatMonitoring' },
    { col: 'chat_monitoring_enabled_at', kind: 'ts', ddl: `TIMESTAMPTZ`, owner: 'routes/compliance/chatMonitoring' },
    // The deciding admin's id: accountability in the row, never in evidence.
    { col: 'chat_monitoring_enabled_by', kind: 'text', ddl: `TEXT`, owner: 'routes/compliance/chatMonitoring' },
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
//   chat_monitoring_* → routes/compliance/chatMonitoring.js refuses a save
//     whose preconditions do not hold (DPIA, works council, notice, legal
//     basis), lets only an org admin widen, stamps, evidences and invalidates
//     the resolver that the in-chat notice and the recorder share.
// Straight through a PUT body these are a forged attestation and a licence
// bypass respectively, so sanitizeSettingsPatch drops them.
const SETTINGS_REQUEST_DENY = Object.freeze(SETTINGS_FIELDS.filter(f => f.owner).map(f => f.col));

module.exports = { SETTINGS_FIELDS, SETTINGS_READONLY, SETTINGS_REQUEST_DENY };

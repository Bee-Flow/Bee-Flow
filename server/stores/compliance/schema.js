// @typecheck strict
/**
 * The boot DDL of the compliance store: every table, index and additive
 * column, in the order the store has always created them. The barrel
 * (stores/complianceStore.js) wraps the returned function in makeStoreInit
 * and hands in exec / runDdl, so this module requires no database itself.
 */

const { SETTINGS_FIELDS } = require('./settingsFields');
const { FINDING_DDL } = require('./findings');

/**
 * @param {{ exec: Function, runDdl: Function }} deps
 */
function createSchema({ exec, runDdl }) {
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

    return _initDB;
}

module.exports = { createSchema };

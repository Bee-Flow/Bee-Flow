// @typecheck strict
/**
 * The schema of Cowork templates (2026-11), as idempotent boot DDL that stores/coworkTemplates.mts applies through
 * runDdl once the Cowork schema itself is there (stores/coworkStore.js initDB).
 *
 * A template is a cowork a member saved for their organisation (usecases/coworkTemplates.mts): its title, its brief,
 * how often it repeats and, when the item had an approved plan, that plan's definition as the export sanitiser left
 * it (automation/portability.js buildExport: no connection, no credential, no approver, no captured test data). Never
 * the item's runs, its recipients or anything else that belongs to one person.
 *
 * `fingerprint` is the plan's fingerprint as it was saved (core/cowork/plan/planPermissions.mts planFingerprint); a
 * definition that does not match it is not offered as a plan. What a plan may do is NOT stored: it is worked out
 * from the definition every time the template is shown, so a stored list can never say less than the plan does.
 *
 * `created_by` is nullable: when the person who saved it is erased, the template stays the organisation's and the
 * column is cleared (stores/user/erasureCoverage.js, `detached`).
 */

const TEMPLATE_DDL = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_templates (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        created_by TEXT,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        repeat_interval TEXT,
        definition JSONB,
        fingerprint TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cowork_templates_org ON cowork_templates (organization_id, created_at DESC)`,
]);

module.exports = { TEMPLATE_DDL };

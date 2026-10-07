/**
 * GDPR Art. 30(4) — a registered processing has to STAY true.
 *
 * The playbook's compliance phase registers a Studio table: a legal basis, a
 * retention period and the date column it is counted from. That is a claim
 * about the world, made once. This check goes back and reads whether it still
 * holds — per registered table, so each processing gets its own row in the
 * Compliance Center rather than one verdict for all of them.
 *
 * Five ways a registration stops being true, in the order they matter:
 *   1. the legal basis is gone, or is not one Art. 6 offers;
 *   2. the retention column is gone — the clean-up has nothing to measure;
 *   3. a retention period with no column at all, which never fires;
 *   4. rows sit outside the window the register promises — so the clean-up is
 *      not running, whatever the register says;
 *   5. nobody has re-confirmed it inside the interval the organisation set
 *      (Compliance → Settings, "re-confirm a registered processing every N
 *      days" — `datatable_review_days`, 180 by default).
 *
 * Reads only. What it finds is a check result, not a change.
 *
 * AND — since 2026-09-21 — it also reports its own COVERAGE. The five verdicts
 * above are only ever about tables someone already recorded something for. An
 * organisation that registered nothing therefore had nothing judged, and the
 * Compliance Center scored it over the checks that DID run: the less of the
 * workspace was looked at, the greener the dashboard. `listCoverage()` closes
 * that by handing the runner the whole population and the part of it this
 * check never opened, by name, so the score is reported next to what it was
 * computed over instead of standing in for it.
 */

const complianceStore = require('../../../stores/complianceStore');

const LAWFUL_BASES = Object.freeze(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']);
const DEFAULT_REVIEW_DAYS = 180;

function defaultDeps() {
    return {
        getAll: (...a) => require('../../../db').getAll(...a),
        getTableMeta: (...a) => require('../../../stores/datatableStore').getTableMeta(...a),
        countOutside: async (row, meta) => {
            // The SAME query the retention job runs before it deletes
            // (jobs/datatableRetention.js) — `compileSelectOlderThan` with the
            // table's own owner filter. Asking a different question would let
            // the check and the job disagree about the same rows.
            const queryCompiler = require('../../../core/dataEngine/queryCompiler');
            const datatableDbStore = require('../../../stores/datatableDbStore');
            const scope = { kind: row.scope_kind, id: row.scope_id };
            const scopeKey = datatableDbStore.scopeKey(scope);
            const cutoffIso = new Date(Date.now() - Number(row.retention_days) * 86400000).toISOString();
            const probe = queryCompiler.compileSelectOlderThan(meta, null, {
                field: row.retention_field, cutoffIso, limit: 500, dialect: 'pg',
            });
            const found = await datatableDbStore.query(scopeKey, scopeKey, probe.sql, probe.params);
            return (found.rows || []).length;
        },
        now: () => Date.now(),
    };
}

// WHAT "REGISTERED" MEANS — one definition, written twice on purpose.
//
// A table is in the processing register once someone recorded a legal basis
// or a retention period for it. That is not a rule invented here: it is the
// predicate `compliance/ropa/datatableActivities.js` uses to decide what goes
// into the Art. 30 record the RoPA page renders, and routes/compliance/ropa.js
// pushes exactly those activities into the document. Coverage has to be
// measured against THAT register or the product would be answering for two
// different ones. The SQL form and the JavaScript form below must stay the
// same sentence — `_allTables` splits the population in JS, `_registeredTables`
// asks the database, and a drift between them would put a table in the
// register but outside the coverage count, or the reverse.
const REGISTERED_SQL = '(lawful_basis IS NOT NULL OR retention_days IS NOT NULL)';
const isRegistered = (row) => row?.lawful_basis != null || row?.retention_days != null;

/**
 * Every table of this org that someone has recorded something about.
 *
 * Does NOT swallow its errors. The subject list retires vanished slots
 * (`retiresVanished`), so an empty register read off a failed query would
 * retire every table's slot; the error goes up instead — to the runner, which
 * records the listing as incomplete, or to `evaluate`, which says it could not
 * re-check this run.
 */
async function _registeredTables(orgId, deps) {
    return (await deps.getAll(`
        SELECT id, name, scope_kind, scope_id,
               lawful_basis, retention_days, retention_field, subject_column,
               updated_at, created_at
          FROM datatables
         WHERE organization_id = $1
           AND ${REGISTERED_SQL}
         ORDER BY created_at ASC
    `, [orgId])) || [];
}

/**
 * EVERY table of this org — registered or not. Deliberately not filtered.
 *
 * This one does NOT swallow its errors either, and that is the whole point of
 * it. `_allTables` returning [] on a failed read would say
 * "this workspace has no tables at all", i.e. "there is nothing we failed to
 * look at" — the exact false reassurance this function exists to prevent. A
 * database that cannot be read must surface as unknown coverage, so the error
 * travels up to the runner, which records the run as covering an unknown share.
 */
async function _allTables(orgId, deps) {
    return deps.getAll(`
        SELECT id, name, lawful_basis, retention_days, created_at
          FROM datatables
         WHERE organization_id = $1
         ORDER BY created_at ASC
    `, [orgId]);
}

/**
 * The population this check judges, and the part of it that it never opened.
 *
 * `unexamined` is the list of tables nobody has recorded a legal basis or a
 * retention period for. They are not accused of anything — a scratch table
 * genuinely may hold no personal data, and `datatableActivities` is explicit
 * that auto-listing every table would turn the register into a list of tables.
 * The claim here is narrower and it is about US, not about them: these are the
 * tables no compliance artifact has ever mentioned, so nothing this check says
 * above covers them, and neither does the score.
 */
async function listCoverage(orgId, deps = defaultDeps()) {
    const rows = (await _allTables(orgId, deps)) || [];
    const unexamined = rows.filter((r) => !isRegistered(r));
    return {
        kind: 'datatable',
        label: 'Studio tables',
        total: rows.length,
        examined: rows.length - unexamined.length,
        unexamined: unexamined.map((r) => ({ id: r.id, label: r.name || r.id })),
        link: 'admin/compliance/ropa',
        // The runner writes the row; the words for what "examined" means here
        // and where to go about it belong to this check, which is the only
        // module that knows a Studio table from a supplier contract.
        examined_as: 'recorded in the processing register',
        next_step: 'Open Compliance → Processing register and record what each one holds — or say it holds no personal data.',
    };
}

/** The one verdict for one registered table. Pure, given the row and the facts. */
function verdict(row, { fields, outside, reviewDays, lastReviewed, now }) {
    const name = row.name || row.id;
    const keys = new Set((fields || []).map((f) => f && f.key).filter(Boolean));
    const evidence = {
        datatable_id: row.id,
        lawful_basis: row.lawful_basis || null,
        retention_days: row.retention_days || null,
        retention_field: row.retention_field || null,
        subject_column: row.subject_column || null,
    };

    if (!row.lawful_basis) {
        return { status: 'fail', evidence, details: `"${name}" is in the processing register with no legal basis. Art. 30(1)(c) asks for one.` };
    }
    if (!LAWFUL_BASES.includes(row.lawful_basis)) {
        return { status: 'fail', evidence, details: `"${name}" records "${row.lawful_basis}" as its legal basis, which is not one of the six Art. 6 offers.` };
    }
    const days = Number(row.retention_days);
    const hasDays = Number.isFinite(days) && days > 0;
    if (hasDays && !row.retention_field) {
        return { status: 'fail', evidence, details: `"${name}" says rows are kept ${days} days, but records no date to count from — so nothing is ever deleted.` };
    }
    if (hasDays && keys.size && !keys.has(row.retention_field)) {
        return { status: 'fail', evidence, details: `"${name}" counts its retention from "${row.retention_field}", and that column is no longer in the table — the clean-up has nothing to measure.` };
    }
    if (hasDays && Number.isFinite(outside) && outside > 0) {
        return {
            status: 'warn',
            evidence: { ...evidence, rows_outside_window: outside },
            details: `"${name}" promises ${days} days, and ${outside} row(s) are older than that. The clean-up has not removed them — check that retention is switched on for this table.`,
        };
    }
    if (!hasDays) {
        return { status: 'warn', evidence, details: `"${name}" has a legal basis but no retention period. Art. 5(1)(e) asks how long you keep it.` };
    }
    const ageDays = lastReviewed ? Math.floor((now - lastReviewed) / 86400000) : null;
    if (ageDays !== null && ageDays > reviewDays) {
        return {
            status: 'warn',
            evidence: { ...evidence, reviewed_days_ago: ageDays, review_every_days: reviewDays },
            details: `"${name}" was last confirmed ${ageDays} days ago and your interval is ${reviewDays}. Re-read it and mark the register reviewed.`,
        };
    }
    return {
        status: 'pass',
        evidence: { ...evidence, rows_outside_window: Number.isFinite(outside) ? outside : null, reviewed_days_ago: ageDays },
        details: `"${name}": ${row.lawful_basis}, kept ${days} days from "${row.retention_field}", nothing outside the window.`,
    };
}

module.exports = {
    id: 'GDPR-Art30-datatable-registrations',
    regulation: 'GDPR',
    article: '30',
    severity: 'medium',
    scope: 'per-source',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art30_datatables.title',
    descriptionKey: 'compliance.checks.gdpr_art30_datatables.desc',
    remediationKey: 'compliance.checks.gdpr_art30_datatables.fix',
    remediationLink: 'admin/compliance/ropa',

    // The subject list is the WHOLE register (no LIMIT), so the runner may
    // retire the slot of a table that left it. Otherwise a table taken out of
    // the register kept its last warning in the score for good.
    retiresVanished: true,
    retiredDetails: 'This table is no longer in the processing register, or it was deleted.',

    async listSubjects(orgId, deps = defaultDeps()) {
        const rows = await _registeredTables(orgId, deps);
        return rows.map((r) => ({ id: `datatable:${r.id}`, label: r.name || r.id }));
    },

    async evaluate(orgId, subject, deps = defaultDeps()) {
        if (!subject || !subject.id) {
            return { status: 'not_applicable', evidence: {}, details: 'No registered table to re-check.' };
        }
        const id = String(subject.id).replace(/^datatable:/, '');
        // A failed read is not "no longer in the register": that answer is
        // not_applicable and drops the table out of the score. Only the
        // SQLSTATE travels — a raw error message can carry query text.
        let rows;
        try {
            rows = await _registeredTables(orgId, deps);
        } catch (e) {
            return {
                status: 'warn',
                evidence: { datatable_id: id, error: 'register_unreadable', sqlstate: e?.code || null },
                details: 'The processing register could not be read, so this table was not re-checked this run.',
            };
        }
        const row = rows.find((r) => r.id === id);
        if (!row) {
            return { status: 'not_applicable', evidence: { datatable_id: id }, details: 'That table is no longer in the register.' };
        }
        const settings = await complianceStore.getSettings(orgId).catch(() => ({}));
        const reviewDays = Number(settings.datatable_review_days) > 0 ? Number(settings.datatable_review_days) : DEFAULT_REVIEW_DAYS;
        const reviewedAt = settings.ropa_reviewed_at ? Date.parse(settings.ropa_reviewed_at) : null;
        let fields = [];
        try {
            const meta = await deps.getTableMeta({ kind: row.scope_kind, id: row.scope_id }, row.id);
            fields = (meta && meta.fields) || [];
        } catch { /* an unreadable table still has a registration to judge */ }
        let outside = null;
        if (Number(row.retention_days) > 0 && row.retention_field) {
            try { outside = await deps.countOutside(row, { fields }); } catch { outside = null; }
        }
        return verdict(row, {
            fields,
            outside,
            reviewDays,
            lastReviewed: Number.isFinite(reviewedAt) ? reviewedAt : null,
            now: deps.now(),
        });
    },

    // Optional contract (compliance/runner.js): a check that can name its own
    // population declares it here, and the runner turns the gap into a row of
    // its own so an unexamined table is visible in the Center instead of being
    // silently absent from the score.
    listCoverage,

    // Exported for the tests: the verdict is the whole of the judgement.
    _verdict: verdict,
    _registeredTables,
    _allTables,
    isRegistered,
    DEFAULT_REVIEW_DAYS,
    LAWFUL_BASES,
};

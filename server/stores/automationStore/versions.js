// @typecheck
/**
 * versions.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const { initDB, getOne, getAll } = require('./core');
const { safeParse } = require('./rowMappers');

async function listVersions(automationId) {
    await initDB();
    // LEFT JOIN users so the panel can show who saved each version. The
    // users table lives in the same core DB; the join degrades gracefully
    // (savedByName = null) for system saves or deleted users.
    const rows = await getAll(
        `SELECT av.id, av.automation_id, av.version, av.saved_by_user_id, av.saved_at, av.change_summary,
                av.name, av.description, av.description_json, av.is_layout_only,
                u."displayName" AS u_display_name, u."firstName" AS u_first_name,
                u."lastName" AS u_last_name, u.username AS u_username
           FROM automation_versions av
           LEFT JOIN users u ON u.id = av.saved_by_user_id
          WHERE av.automation_id = $1
          ORDER BY av.version DESC`,
        [automationId],
    );
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, version: r.version,
        savedByUserId: r.saved_by_user_id, savedAt: r.saved_at,
        changeSummary: r.change_summary || null,
        savedByName: resolveVersionAuthorName(r),
        savedBy: { id: r.saved_by_user_id || null, name: resolveVersionAuthorName(r) },
        ...versionMetaOf(r),
    }));
}

/**
 * Handoff 5 (automation-handoff5-2026-09): a version's milestone name, its
 * plain-language description (text + structured change list), and whether it
 * was a layout-only save (which does not count as a pending change).
 */
function versionMetaOf(r) {
    return {
        name: r.name || null,
        description: r.description || null,
        descriptionJson: r.description_json ?? null,
        isLayoutOnly: !!r.is_layout_only,
    };
}

/** Best display name for a version author, given the joined user columns. */
function resolveVersionAuthorName(r) {
    if (r.u_display_name) return r.u_display_name;
    const full = [r.u_first_name, r.u_last_name].filter(Boolean).join(' ').trim();
    if (full) return full;
    return r.u_username || null;
}

/**
 * Fetch one version by id (the version row contains a JSONB definition).
 * Used by the restore endpoint to load the historical definition before
 * we apply it through the regular updateAutomation path (which also
 * validates and bumps the version counter).
 */
async function getVersion(versionId) {
    await initDB();
    const r = await getOne(
        'SELECT id, automation_id, version, definition_json, saved_by_user_id, saved_at, name, description, description_json, is_layout_only FROM automation_versions WHERE id = $1',
        [versionId],
    );
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        version: r.version,
        definition: typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {}),
        savedByUserId: r.saved_by_user_id,
        savedAt: r.saved_at,
        ...versionMetaOf(r),
    };
}

// Definition snapshot for a specific (automation, version). Run history uses
// this to render each run with the steps as they were AT RUN TIME rather than
// the current definition. Returns the parsed definition, or null when that
// version wasn't snapshotted (e.g. legacy rows from before version seeding).
async function getVersionDefinition(automationId, versionNumber) {
    await initDB();
    const v = Number(versionNumber);
    if (!automationId || !Number.isInteger(v)) return null;
    const r = await getOne(
        'SELECT definition_json FROM automation_versions WHERE automation_id = $1 AND version = $2 ORDER BY saved_at DESC LIMIT 1',
        [automationId, v],
    );
    if (!r) return null;
    return typeof r.definition_json === 'string' ? safeParse(r.definition_json, null) : (r.definition_json || null);
}

// ── Handoff 5, artboard 5d: runs per version, milestones, tab counts ──────
//
// A factory over a `{ query(sql, params) }` handle, like lifecycle.js, so the
// SQL is tested against a real Postgres (versions.pg.test.js) without module
// mocking. The default instance is bound to the pool.

/**
 * Runs as a person counts them: one per JOURNEY (a form or approval pause is
 * continued by child runs sharing root_run_id), its outcome the newest leg's.
 * Test runs (the Test button, dry runs) are left out: they are the editor's.
 */
const COUNTED_RUN_SQL = `
      FROM automation_runs r
      LEFT JOIN LATERAL (
          SELECT l.status FROM automation_runs l
           WHERE COALESCE(l.root_run_id, l.id) = COALESCE(r.root_run_id, r.id)
           ORDER BY l.started_at DESC NULLS LAST, l.id DESC
           LIMIT 1
      ) j ON TRUE
     WHERE r.automation_id = $1
       AND (r.root_run_id IS NULL OR r.root_run_id = r.id)
       AND COALESCE(r.is_test, FALSE) = FALSE
       AND r.mode <> 'dry_run'`;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeVersionQueries(db, { ready = async () => {} } = {}) {
    /** version number → { total, failed } over every counted run of the routine. */
    async function countRunsByVersion(automationId) {
        await ready();
        const r = await db.query(
            `SELECT r.version, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE j.status = 'error')::int AS failed
             ${COUNTED_RUN_SQL}
             GROUP BY r.version`,
            [automationId],
        );
        const out = new Map();
        for (const row of r.rows) out.set(Number(row.version), { total: Number(row.total) || 0, failed: Number(row.failed) || 0 });
        return out;
    }

    /** One version by its NUMBER (the id-keyed read is getVersion). */
    async function getVersionByNumber(automationId, versionNumber) {
        await ready();
        const v = Number(versionNumber);
        if (!automationId || !Number.isInteger(v)) return null;
        const r = await db.query(
            `SELECT id, automation_id, version, definition_json, saved_by_user_id, saved_at, change_summary,
                    name, description, description_json, is_layout_only
               FROM automation_versions WHERE automation_id = $1 AND version = $2`,
            [automationId, v],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
            id: row.id,
            automationId: row.automation_id,
            version: row.version,
            definition: typeof row.definition_json === 'string' ? safeParse(row.definition_json, {}) : (row.definition_json || {}),
            savedByUserId: row.saved_by_user_id,
            savedAt: row.saved_at,
            changeSummary: row.change_summary || null,
            ...versionMetaOf(row),
        };
    }

    /** Name a version (a milestone), or clear it with null. Null when there is no such version. */
    async function renameVersion(automationId, versionNumber, name) {
        await ready();
        const v = Number(versionNumber);
        if (!automationId || !Number.isInteger(v)) return null;
        const r = await db.query(
            `UPDATE automation_versions SET name = $3
              WHERE automation_id = $1 AND version = $2
              RETURNING id, version, name`,
            [automationId, v, name == null ? null : String(name)],
        );
        const row = r.rows[0];
        return row ? { id: row.id, version: row.version, name: row.name || null } : null;
    }

    /**
     * The Builder header's tab badges, in two cheap reads. `onlyUserId` narrows
     * the run counts to the runs that person started or submitted (a run-only
     * share sees only their own runs).
     */
    async function countsForAutomation(automationId, { days = 7, onlyUserId = null } = {}) {
        await ready();
        const params = [automationId, days];
        let mine = '';
        if (onlyUserId) {
            params.push(onlyUserId);
            mine = ' AND (r.started_by_user_id = $3 OR r.submitted_by_user_id = $3)';
        }
        const runs = await db.query(
            `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE j.status = 'error')::int AS failed
             ${COUNTED_RUN_SQL}
               AND COALESCE(r.started_at, r.created_at) >= NOW() - ($2::int * INTERVAL '1 day')${mine}`,
            params,
        );
        const versions = await db.query(
            'SELECT COUNT(*)::int AS n FROM automation_versions WHERE automation_id = $1 AND is_layout_only = FALSE',
            [automationId],
        );
        return {
            runs7d: Number(runs.rows[0]?.total) || 0,
            runsFailed7d: Number(runs.rows[0]?.failed) || 0,
            versions: Number(versions.rows[0]?.n) || 0,
        };
    }

    return { countRunsByVersion, getVersionByNumber, renameVersion, countsForAutomation };
}

const { pool } = require('./core');
const defaultVersionQueries = makeVersionQueries(
    { query: (sql, params) => pool.query(sql, params) },
    { ready: initDB },
);

module.exports = {
    listVersions, getVersion, getVersionDefinition, versionMetaOf,
    makeVersionQueries,
    countRunsByVersion: defaultVersionQueries.countRunsByVersion,
    getVersionByNumber: defaultVersionQueries.getVersionByNumber,
    renameVersion: defaultVersionQueries.renameVersion,
    countsForAutomation: defaultVersionQueries.countsForAutomation,
};

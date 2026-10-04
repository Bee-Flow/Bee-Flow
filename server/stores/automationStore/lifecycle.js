// @typecheck
/**
 * lifecycle.js — the live/working split, the trash and per-automation run
 * retention (Studio → Automations handoff 5, automation-handoff5-2026-09).
 *
 * ── The live split ───────────────────────────────────────────────────────
 * `definition_json` / `version` is the WORKING copy: every editor save lands
 * there and bumps the version. `live_definition_json` / `live_version` is
 * what scheduled, event, webhook, form, app and agent runs execute, and it
 * only moves when the owner publishes (POST /:id/publish), or on first
 * activation of an automation that was never live. Test runs execute the working
 * copy (core/automationRunner/definitionForRun.js).
 *
 * Two invariants keep the pair honest whichever path writes the row, and both
 * live in LIVE_INVARIANT_SQL so automations.updateAutomation and this module
 * share one statement:
 *   1. an ACTIVE automation always has a live version — a path that switches a
 *      never-live automation on (provisioning, an installer, the support inbox)
 *      publishes its working copy in the same transaction;
 *   2. a write flagged `goLive` (an approved evolution, a package upgrade)
 *      moves the live copy with it, on an automation that is or has been live.
 *
 * ── The trash ────────────────────────────────────────────────────────────
 * DELETE is a soft delete: `deleted_at` / `deleted_by`, switched off, runs
 * kept. Every read of the automations table excludes trashed rows unless it
 * asks for them. jobs/automationTrashPurge.js hard-deletes after
 * TRASH_RETENTION_DAYS; the FKs cascade, so runs go with the automation then.
 *
 * Factory over a `{ query(sql, params) }` handle so the SQL is tested against
 * a real Postgres (lifecycle.pg.test.js) without reaching into the module
 * system. The default instance is bound to the pool.
 */

const TRASH_RETENTION_DAYS = 30;

/**
 * Structural versions saved after the live one. Layout-only saves do not count
 * ("you are editing v5 · 2 changes not live yet"). Zero while never live.
 */
const PENDING_CHANGES_SQL = `(SELECT COUNT(*)::int FROM automation_versions v
          WHERE v.automation_id = a.id
            AND a.live_version IS NOT NULL
            AND v.version > a.live_version
            AND v.is_layout_only = FALSE)`;

/** `SELECT` list every automation read uses, so pendingChanges is always there. */
const AUTOMATION_SELECT = `SELECT a.*, ${PENDING_CHANGES_SQL} AS pending_changes FROM automations a`;

/** See invariants 1 and 2 in the header. $1 = id, $2 = goLive. */
const LIVE_INVARIANT_SQL = `UPDATE automations
            SET live_definition_json = definition_json,
                live_version = version,
                live_at = NOW()
          WHERE id = $1
            AND COALESCE(kind, 'automation') = 'automation'
            AND deleted_at IS NULL
            AND ((live_version IS NULL AND is_active = TRUE)
                 OR ($2::boolean AND (live_version IS NOT NULL OR is_draft = FALSE)))`;

/**
 * The trigger-derived columns follow the LIVE definition. On an automation that has
 * one, a plain working-copy write may not move them — only a publish (or a
 * `goLive` write) may. next_run_at is not on the list: the runner advances it
 * after every scheduled run, which is a live fact.
 */
const LIVE_FOLLOWING_FIELDS = Object.freeze(['triggerType', 'scheduleCron', 'scheduleTz']);

/**
 * `updates` minus the fields a working-copy write may not move on a live
 * automation. Pure; returns a new object.
 *
 * @param {Record<string, any>} updates
 * @param {{ hasLive: boolean, goLive?: boolean }} opts
 */
function stripLiveFollowingFields(updates, { hasLive, goLive = false }) {
    const out = { ...updates };
    if (hasLive && !goLive) for (const f of LIVE_FOLLOWING_FIELDS) delete out[f];
    return out;
}

/**
 * The stage lookup of the managed-write guard: an automation's project_id and
 * live_version and nothing else (the row's working copy, live copy and builder
 * session can run to megabytes). project_id is selected directly, never
 * probed: a schema without it fails loudly instead of switching the lock off.
 *
 * @returns {(q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }, id: string,
 *            opts?: { forUpdate?: boolean }) => Promise<{ project_id: string|null, live_version: number|null }|null>}
 */
function makeStageLookup() {
    return async function stageOf(q, id, { forUpdate = false } = {}) {
        const r = await q.query(
            `SELECT project_id, live_version FROM automations WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
            [id],
        );
        return r.rows[0] || null;
    };
}

/**
 * Built over the pool for the app, and over one transaction's client for a
 * deploy's commit (`makeLifecycleStore(client)`): every statement, the
 * managed-write guard's capability check included, then runs on that client.
 *
 * `managedParts` is the guard (stores/lib/managedParts.js); a test passes its
 * own instance, the app the module's default.
 *
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} db
 * @param {{ ready?: () => Promise<void>, managedParts?: { assertManagedWrite: Function }|null }} [opts]
 */
function makeLifecycleStore(db, { ready = async () => {}, managedParts = null } = {}) {
    const { rowToAutomation } = require('./rowMappers');
    const guard = () => managedParts || require('../lib/managedParts');
    const stageOf = makeStageLookup();

    /**
     * Refuse a write to an automation of a Solution stage unless the keys are
     * allow-listed or `managedWrite` names an active deployment of that stage.
     */
    async function assertManaged(id, changedKeys, managedWrite) {
        const row = await stageOf(db, id);
        if (!row) return;
        await guard().assertManagedWrite({
            kind: 'automation', projectId: row.project_id ?? null, changedKeys, managedWrite,
            client: db, liveVersion: row.live_version ?? null,
        });
    }

    async function selectOne(id, { includeDeleted = false } = {}) {
        const r = await db.query(
            `${AUTOMATION_SELECT} WHERE a.id = $1${includeDeleted ? '' : ' AND a.deleted_at IS NULL'}`,
            [id],
        );
        return rowToAutomation(r.rows[0] || null);
    }

    /**
     * Copy the working copy to live. `expectedVersion` makes it exact: the
     * caller validated version N, so only version N may go live — a save that
     * landed in between answers null and the route says so (409), rather
     * than publishing something nobody checked.
     *
     * `columns` are the trigger-derived columns of that definition, written in
     * the same statement so the scheduler and the live copy never disagree.
     *
     * On an automation of a Solution stage only a deploy publishes: it passes
     * `managedWrite` (its capability), on the commit transaction's client.
     *
     * @param {string} id
     * @param {{ expectedVersion?: number, columns?: {
     *   triggerType?: string, scheduleCron?: string|null, scheduleTz?: string, nextRunAt?: string|null,
     *   runTimeoutMs?: number|null, isActive?: boolean, isDraft?: boolean, needsFirstRunConfirm?: boolean,
     * }, managedWrite?: { deploymentId?: string }|null }} [opts]
     */
    async function publishWorkingCopy(id, { expectedVersion, columns = {}, managedWrite = null } = {}) {
        await ready();
        const moved = Object.keys(columns).filter((k) => columns[k] !== undefined);
        await assertManaged(id, ['liveDefinition', ...moved], managedWrite);
        const set = [
            'live_definition_json = definition_json',
            'live_version = version',
            'live_at = NOW()',
            'updated_at = NOW()',
        ];
        const params = [id, expectedVersion];
        const add = (col, value) => { params.push(value); set.push(`${col} = $${params.length}`); };
        if (columns.triggerType !== undefined) add('trigger_type', columns.triggerType);
        if (columns.scheduleCron !== undefined) add('schedule_cron', columns.scheduleCron);
        if (columns.scheduleTz !== undefined) add('schedule_tz', columns.scheduleTz);
        if (columns.nextRunAt !== undefined) add('next_run_at', columns.nextRunAt);
        if (columns.runTimeoutMs !== undefined) add('run_timeout_ms', columns.runTimeoutMs);
        if (columns.isActive !== undefined) add('is_active', columns.isActive);
        if (columns.isDraft !== undefined) add('is_draft', columns.isDraft);
        if (columns.needsFirstRunConfirm !== undefined) add('needs_first_run_confirm', columns.needsFirstRunConfirm);
        const r = await db.query(
            `UPDATE automations SET ${set.join(', ')}
              WHERE id = $1 AND version = $2 AND deleted_at IS NULL
              RETURNING id`,
            params,
        );
        if (!r.rows.length) return null;
        return selectOne(id);
    }

    /** Structural versions after the live one (see PENDING_CHANGES_SQL). */
    async function countPendingChanges(id) {
        await ready();
        const r = await db.query(`SELECT ${PENDING_CHANGES_SQL} AS n FROM automations a WHERE a.id = $1`, [id]);
        return Number(r.rows[0]?.n) || 0;
    }

    /**
     * Soft delete: into the trash, switched off, runs kept. Null when absent
     * or already trashed. An automation of a Solution stage is retired by a
     * deploy, never trashed by hand (409 managed_part without `managedWrite`).
     */
    async function trashAutomation(id, deletedBy, { managedWrite = null } = {}) {
        await ready();
        await assertManaged(id, ['deletedAt'], managedWrite);
        const r = await db.query(
            `UPDATE automations
                SET deleted_at = NOW(), deleted_by = $2, is_active = FALSE, next_run_at = NULL, updated_at = NOW()
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING id`,
            [id, deletedBy || null],
        );
        if (!r.rows.length) return null;
        return selectOne(id, { includeDeleted: true });
    }

    /** Out of the trash — always PAUSED, whatever it was before. Null when not in the trash. */
    async function restoreAutomation(id, { managedWrite = null } = {}) {
        await ready();
        await assertManaged(id, ['deletedAt'], managedWrite);
        const r = await db.query(
            `UPDATE automations
                SET deleted_at = NULL, deleted_by = NULL, is_active = FALSE, next_run_at = NULL, updated_at = NOW()
              WHERE id = $1 AND deleted_at IS NOT NULL
              RETURNING id`,
            [id],
        );
        if (!r.rows.length) return null;
        return selectOne(id);
    }

    /** One owner's trash, newest first, with the date each one is purged. */
    async function listTrash(userId) {
        await ready();
        const r = await db.query(
            `${AUTOMATION_SELECT}
              WHERE a.user_id = $1 AND a.deleted_at IS NOT NULL AND COALESCE(a.kind, 'automation') = 'automation'
              ORDER BY a.deleted_at DESC`,
            [userId],
        );
        return r.rows.map((row) => {
            const a = rowToAutomation(row);
            const purgeAt = a && a.deletedAt
                ? new Date(new Date(a.deletedAt).getTime() + TRASH_RETENTION_DAYS * 86_400_000).toISOString()
                : null;
            return { ...a, purgeAt };
        });
    }

    /** Trashed rows past the retention window, oldest first. */
    async function listPurgeableTrash({ days = TRASH_RETENTION_DAYS, limit = 100 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT id, user_id, organization_id FROM automations
              WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1::int * INTERVAL '1 day')
              ORDER BY deleted_at ASC
              LIMIT $2`,
            [days, limit],
        );
        return r.rows.map((row) => ({ id: row.id, userId: row.user_id, organizationId: row.organization_id || null }));
    }

    /**
     * Hard delete one trashed row (the purge). Refuses a row that was restored
     * meanwhile — `deleted_at IS NOT NULL` is re-checked in the statement.
     */
    async function purgeTrashedAutomation(id) {
        await ready();
        const r = await db.query('DELETE FROM automations WHERE id = $1 AND deleted_at IS NOT NULL', [id]);
        return (r.rowCount || 0) > 0;
    }

    /**
     * Per-automation run retention: `definition.runPolicy.retentionDays` (7..365)
     * shortens the platform window for that automation's runs. runPolicy is a
     * SETTING (core/automationRunner/definitionForRun.js SETTINGS_KEYS): it
     * applies without a publish, so this reads the WORKING copy. An automation with no
     * valid value, or one at or above the platform window, is the platform
     * pass's business. `platformDays <= 0` (platform retention off) still
     * honours the automation's own window.
     *
     * Terminal runs only; bounded, oldest first, like deleteRunsOlderThan.
     */
    async function deleteRunsPastAutomationRetention({ platformDays = 0, limit = 5000 } = {}) {
        await ready();
        const days = `(a.definition_json->'runPolicy'->>'retentionDays')`;
        const r = await db.query(
            `DELETE FROM automation_runs
              WHERE id IN (
                  SELECT r.id FROM automation_runs r
                    JOIN automations a ON a.id = r.automation_id
                   WHERE r.status IN ('success', 'error', 'cancelled')
                     AND ${days} ~ '^[0-9]{1,3}$'
                     AND ${days}::int BETWEEN 7 AND 365
                     AND ($1::int <= 0 OR ${days}::int < $1::int)
                     AND COALESCE(r.finished_at, r.created_at) < NOW() - (${days}::int * INTERVAL '1 day')
                   ORDER BY COALESCE(r.finished_at, r.created_at) ASC
                   LIMIT $2
              )`,
            [platformDays, limit],
        );
        return r.rowCount || 0;
    }

    return {
        selectOne,
        publishWorkingCopy,
        countPendingChanges,
        trashAutomation,
        restoreAutomation,
        listTrash,
        listPurgeableTrash,
        purgeTrashedAutomation,
        deleteRunsPastAutomationRetention,
    };
}

// The instance the app uses: the pool, behind the store's schema init.
const { initDB, pool } = require('./core');
const defaultStore = makeLifecycleStore(
    { query: (sql, params) => pool.query(sql, params) },
    { ready: initDB },
);

module.exports = {
    TRASH_RETENTION_DAYS,
    PENDING_CHANGES_SQL,
    AUTOMATION_SELECT,
    LIVE_INVARIANT_SQL,
    LIVE_FOLLOWING_FIELDS,
    stripLiveFollowingFields,
    makeStageLookup,
    makeLifecycleStore,
    publishWorkingCopy: defaultStore.publishWorkingCopy,
    countPendingChanges: defaultStore.countPendingChanges,
    trashAutomation: defaultStore.trashAutomation,
    restoreAutomation: defaultStore.restoreAutomation,
    listTrash: defaultStore.listTrash,
    listPurgeableTrash: defaultStore.listPurgeableTrash,
    purgeTrashedAutomation: defaultStore.purgeTrashedAutomation,
    deleteRunsPastAutomationRetention: defaultStore.deleteRunsPastAutomationRetention,
};

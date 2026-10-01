// @typecheck
/**
 * Sprints inside a collaborative project: a named time box with a goal, a
 * status (planned, active, closed) and an optional capacity in story points.
 * The tasks in one carry its id (`project_tasks.sprint_id`, set to NULL when
 * the sprint goes away, so deleting a sprint never deletes a task).
 *
 * The name and the goal are sealed with the project key by the route
 * (projects/chatCrypto.js, the sprint id standing in for the chat id) before
 * they reach this store; this store never sees plaintext of either. What it
 * keeps in the clear is what the sprints panel needs to filter and sort:
 * status, dates, capacity and order — plus a per-sprint rollup of its tasks
 * (how many, how many points, how much of it done), read with a join.
 *
 * One sprint per project is active at a time: `startSprint` demotes the one
 * that is and activates the asked one in a single statement.
 *
 * Built by a factory over a `{ query }` handle so the pg test runs the
 * store's own SQL against PGlite; the default instance wraps the pool.
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const STATUSES = Object.freeze(['planned', 'active', 'closed']);
/** Room left between two neighbours in the list, so a reorder usually changes one row. */
const RANK_STEP = 1000;

const DDL = `
    CREATE TABLE IF NOT EXISTS project_sprints (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        goal             TEXT NOT NULL DEFAULT '',
        start_date       DATE,
        end_date         DATE,
        status           TEXT NOT NULL DEFAULT 'planned'
                         CONSTRAINT project_sprints_status_check CHECK (status IN ('planned', 'active', 'closed')),
        capacity_points  INTEGER,
        sort_order       BIGINT NOT NULL DEFAULT 0,
        created_by       TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_sprints_project
        ON project_sprints(project_id, sort_order, created_at);
    DO $$ BEGIN
        ALTER TABLE project_sprints ADD CONSTRAINT project_sprints_date_range CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS sprint_id TEXT REFERENCES project_sprints(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_project_tasks_sprint
        ON project_tasks(project_id, sprint_id) WHERE sprint_id IS NOT NULL;
`;

class ProjectSprintStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectSprintStoreError';
        this.code = code;
    }
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);
/** A DATE column as `YYYY-MM-DD`, whatever the driver made of it. */
const toDay = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    const d = new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A sprint row as stored, with its task rollup when the query joined it. `name` and `goal` are still sealed. */
function rowToSprint(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        name: r.name,
        goal: r.goal || '',
        startDate: toDay(r.start_date),
        endDate: toDay(r.end_date),
        status: r.status,
        capacityPoints: r.capacity_points == null ? null : Number(r.capacity_points),
        sortOrder: Number(r.sort_order) || 0,
        itemCount: r.item_count == null ? 0 : Number(r.item_count),
        pointsTotal: r.points_total == null ? 0 : Number(r.points_total),
        pointsDone: r.points_done == null ? 0 : Number(r.points_done),
        doneCount: r.done_count == null ? 0 : Number(r.done_count),
        createdBy: r.created_by,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

/** The sprint plus the counts and points of the tasks in it, for one row or the whole list. */
const WITH_ROLLUP = `
    FROM project_sprints s
    LEFT JOIN project_tasks t ON t.project_id = s.project_id AND t.sprint_id = s.id
`;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {{ ready?: () => Promise<any> }} [opts]
 */
function makeProjectSprintStore(db, { ready = async () => {} } = {}) {
    /** The rank that puts a sprint at the end of the list. */
    async function endRank(projectId) {
        const r = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS top FROM project_sprints WHERE project_id = $1', [projectId]);
        return Number(r.rows[0].top) + RANK_STEP;
    }

    /**
     * @param {{ id: string, projectId: string, name: string, goal?: string, createdBy: string,
     *           startDate?: string|null, endDate?: string|null, capacityPoints?: number|null }} s  name and goal sealed
     */
    async function createSprint(s) {
        await ready();
        if (s.startDate && s.endDate && s.startDate > s.endDate) {
            throw new ProjectSprintStoreError('INVALID_DATE_RANGE', 'startDate must be on or before endDate');
        }
        const r = await db.query(
            `INSERT INTO project_sprints (id, project_id, name, goal, start_date, end_date, capacity_points, sort_order, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [s.id, s.projectId, s.name, s.goal || '', s.startDate || null, s.endDate || null,
                s.capacityPoints == null ? null : s.capacityPoints, await endRank(s.projectId), s.createdBy],
        );
        return getSprint(s.projectId, r.rows[0].id);
    }

    /** One sprint, only when it belongs to this project, with its task rollup. */
    async function getSprint(projectId, sprintId) {
        await ready();
        const r = await db.query(
            `SELECT s.*, COUNT(t.id)::int AS item_count,
                    COALESCE(SUM(t.story_points), 0)::int AS points_total,
                    COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'done'), 0)::int AS points_done,
                    COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count
               ${WITH_ROLLUP}
              WHERE s.id = $1 AND s.project_id = $2 GROUP BY s.id`,
            [sprintId, projectId],
        );
        return rowToSprint(r.rows[0] || null);
    }

    /** Every sprint of the project, in list order, each with its task rollup. */
    async function listSprints(projectId) {
        await ready();
        const r = await db.query(
            `SELECT s.*, COUNT(t.id)::int AS item_count,
                    COALESCE(SUM(t.story_points), 0)::int AS points_total,
                    COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'done'), 0)::int AS points_done,
                    COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count
               ${WITH_ROLLUP}
              WHERE s.project_id = $1 GROUP BY s.id ORDER BY s.sort_order ASC, s.created_at ASC, s.id`,
            [projectId],
        );
        return r.rows.map(rowToSprint);
    }

    /**
     * Change some fields of a sprint. Only the keys present in `patch` are touched.
     *
     * @param {string} projectId
     * @param {string} sprintId
     * @param {{ name?: string, goal?: string, startDate?: string|null, endDate?: string|null,
     *           capacityPoints?: number|null, status?: string }} patch  name and goal sealed
     */
    async function updateSprint(projectId, sprintId, patch) {
        await ready();
        const sets = [];
        const params = [sprintId, projectId];
        const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
        if (patch.name !== undefined) add('name', patch.name);
        if (patch.goal !== undefined) add('goal', patch.goal);
        if (patch.startDate !== undefined) add('start_date', patch.startDate || null);
        if (patch.endDate !== undefined) add('end_date', patch.endDate || null);
        if (patch.capacityPoints !== undefined) add('capacity_points', patch.capacityPoints == null ? null : patch.capacityPoints);
        if (patch.status !== undefined) {
            if (!STATUSES.includes(patch.status)) throw new ProjectSprintStoreError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`);
            add('status', patch.status);
        }
        if (sets.length === 0) return getSprint(projectId, sprintId);
        const r = await db.query(
            `UPDATE project_sprints SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING id`,
            params,
        );
        if (!r.rows[0]) return null;
        return getSprint(projectId, sprintId);
    }

    /** @returns {Promise<boolean>} whether a sprint was removed; its tasks keep existing with no sprint */
    async function deleteSprint(projectId, sprintId) {
        await ready();
        const r = await db.query('DELETE FROM project_sprints WHERE id = $1 AND project_id = $2', [sprintId, projectId]);
        return (r.rowCount || 0) > 0;
    }

    /**
     * Make this sprint the active one. Any other active sprint of the project goes back to
     * planned in the same statement, so a project never has two. Null when the sprint is
     * not in this project.
     */
    async function startSprint(projectId, sprintId) {
        await ready();
        const r = await db.query(
            `WITH demoted AS (
                 UPDATE project_sprints SET status = 'planned', updated_at = NOW()
                  WHERE project_id = $1 AND status = 'active' AND id <> $2
             )
             UPDATE project_sprints SET status = 'active', updated_at = NOW()
              WHERE id = $2 AND project_id = $1 RETURNING id`,
            [projectId, sprintId],
        );
        if (!r.rows[0]) return null;
        return getSprint(projectId, sprintId);
    }

    /** Mark the sprint closed. Null when it is not in this project. */
    async function completeSprint(projectId, sprintId) {
        await ready();
        const r = await db.query(
            `UPDATE project_sprints SET status = 'closed', updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING id`,
            [sprintId, projectId],
        );
        if (!r.rows[0]) return null;
        return getSprint(projectId, sprintId);
    }

    /**
     * Put tasks of this project into the sprint. The route checks first that every id
     * names a task of the project; this sets the column. Returns the ids actually set.
     */
    async function assignTasks(projectId, sprintId, taskIds) {
        await ready();
        if (!taskIds.length) return [];
        const r = await db.query(
            `UPDATE project_tasks SET sprint_id = $3, updated_at = NOW()
              WHERE project_id = $1 AND id = ANY($2::text[]) RETURNING id`,
            [projectId, taskIds, sprintId],
        );
        return r.rows.map((row) => row.id);
    }

    /** Take one task out of the sprint. @returns {Promise<boolean>} whether it was in it */
    async function unassignTask(projectId, sprintId, taskId) {
        await ready();
        const r = await db.query(
            'UPDATE project_tasks SET sprint_id = NULL, updated_at = NOW() WHERE project_id = $1 AND sprint_id = $2 AND id = $3',
            [projectId, sprintId, taskId],
        );
        return (r.rowCount || 0) > 0;
    }

    return { createSprint, getSprint, listSprints, updateSprint, deleteSprint, startSprint, completeSprint, assignTasks, unassignTask };
}

const initDB = makeStoreInit('ProjectSprintStore', _initDB);

async function _initDB() {
    // The sprint column lives on project_tasks, so the task tables (and their projects) come first.
    await require('./projectTaskStore').initDB();
    await exec(DDL);
    log.info('[ProjectSprintStore] PostgreSQL initialized');
}

const defaultStore = makeProjectSprintStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    STATUSES,
    ProjectSprintStoreError,
    makeProjectSprintStore,
    rowToSprint,
    ...defaultStore,
};

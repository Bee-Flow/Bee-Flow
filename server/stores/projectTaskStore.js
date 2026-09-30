// @typecheck
/**
 * Tasks inside a collaborative project: something to do, with an optional
 * description, people it is given to, a due date and links to what it is
 * about (documents, notebooks, team chats and threads of a chat).
 *
 * The title and the description are sealed with the project key by the route
 * (projects/chatCrypto.js, the task id standing in for the chat id) before
 * they reach this store; this store never sees plaintext of either. What it
 * keeps in the clear is what the list needs to filter and sort: status, due
 * date, priority, sort order, assignee ids, link kinds and ids. The labels and
 * the checklist are sealed like the title (the route does it), and `source` is
 * where a task came from (a meeting and one of its action items): ids only.
 *
 * Built by a factory over a `{ query }` handle so the pg test runs the
 * store's own SQL against PGlite; the default instance wraps the pool.
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const STATUSES = Object.freeze(['todo', 'doing', 'done']);
const LINK_KINDS = Object.freeze(['document', 'notebook', 'chat', 'thread', 'meeting']);
const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
/** Room left between two neighbours in a column, so a move usually changes one row. */
const RANK_STEP = 1000;
const MAX_TASKS_LISTED = 500;

const DDL = `
    CREATE TABLE IF NOT EXISTS project_tasks (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'todo'
                      CONSTRAINT project_tasks_status_check CHECK (status IN ('todo', 'doing', 'done')),
        assignee_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
        links         JSONB NOT NULL DEFAULT '[]'::jsonb,
        due_date      DATE,
        created_by    TEXT NOT NULL,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_tasks_project
        ON project_tasks(project_id, status, created_at DESC);
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS labels TEXT NOT NULL DEFAULT '';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS checklist TEXT NOT NULL DEFAULT '';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS sort_order BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS source JSONB;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS notified_due_tier TEXT;
    DO $$ BEGIN
        ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_project_tasks_source
        ON project_tasks ((source->>'id')) WHERE source IS NOT NULL;
`;

class ProjectTaskStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectTaskStoreError';
        this.code = code;
    }
}

/** Where a task came from: `{ kind: 'meeting', id, itemId }`, or null. */
function parseSource(v) {
    const s = parseJson(v, null);
    if (!s || s.kind !== 'meeting' || typeof s.id !== 'string' || !s.id || typeof s.itemId !== 'string' || !s.itemId) return null;
    return { kind: 'meeting', id: s.id, itemId: s.itemId };
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);
/** A DATE column as `YYYY-MM-DD`, whatever the driver made of it. */
const toDay = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    const d = new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function parseJson(v, fallback) {
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (_) { return fallback; }
    }
    return v == null ? fallback : v;
}

function parseAssignees(v) {
    const list = parseJson(v, []);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
}

/** `{ kind, id }`, plus `chatId` for a thread (the chat the thread lives in). Nothing else is kept. */
function parseLinks(v) {
    const list = parseJson(v, []);
    if (!Array.isArray(list)) return [];
    return list
        .filter((x) => x && LINK_KINDS.includes(x.kind) && typeof x.id === 'string' && x.id)
        .map((x) => (x.kind === 'thread' ? { kind: 'thread', id: x.id, chatId: String(x.chatId || '') } : { kind: x.kind, id: x.id }));
}

/** A task row as stored. `title` and `description` are still sealed. */
function rowToTask(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        description: r.description,
        status: r.status,
        assigneeIds: parseAssignees(r.assignee_ids),
        links: parseLinks(r.links),
        dueDate: toDay(r.due_date),
        priority: r.priority || 'normal',
        labels: r.labels || '',
        checklist: r.checklist || '',
        sortOrder: Number(r.sort_order) || 0,
        source: parseSource(r.source),
        notifiedDueTier: r.notified_due_tier || null,
        createdBy: r.created_by,
        completedAt: toIso(r.completed_at),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {{ ready?: () => Promise<any> }} [opts]
 */
function makeProjectTaskStore(db, { ready = async () => {} } = {}) {
    /** The rank that puts a task at the end of a column. */
    async function endRank(projectId, status) {
        const r = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS top FROM project_tasks WHERE project_id = $1 AND status = $2', [projectId, status]);
        return Number(r.rows[0].top) + RANK_STEP;
    }

    /**
     * @param {{ id: string, projectId: string, title: string, description: string, createdBy: string,
     *           status?: string, priority?: string, labels?: string, checklist?: string, assigneeIds?: string[],
     *           links?: object[], dueDate?: string|null, source?: object|null }} t  title, description, labels and checklist sealed
     */
    async function createTask(t) {
        await ready();
        const status = t.status || 'todo';
        if (!STATUSES.includes(status)) throw new ProjectTaskStoreError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`);
        const priority = t.priority || 'normal';
        if (!PRIORITIES.includes(priority)) throw new ProjectTaskStoreError('INVALID_PRIORITY', `priority must be one of ${PRIORITIES.join(', ')}`);
        const r = await db.query(
            `INSERT INTO project_tasks
                (id, project_id, title, description, status, assignee_ids, links, due_date, created_by, completed_at,
                 priority, labels, checklist, sort_order, source)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
             RETURNING *`,
            [t.id, t.projectId, t.title, t.description, status, JSON.stringify(t.assigneeIds || []), JSON.stringify(t.links || []),
                t.dueDate || null, t.createdBy, status === 'done' ? new Date() : null,
                priority, t.labels || '', t.checklist || '', await endRank(t.projectId, status), t.source ? JSON.stringify(t.source) : null],
        );
        return rowToTask(r.rows[0]);
    }

    /** One task, only when it belongs to this project. */
    async function getTask(projectId, taskId) {
        await ready();
        const r = await db.query('SELECT * FROM project_tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
        return rowToTask(r.rows[0] || null);
    }

    /** The project's tasks, in board order (rank), newest last within a column. */
    async function listTasks(projectId) {
        await ready();
        const r = await db.query(
            'SELECT * FROM project_tasks WHERE project_id = $1 ORDER BY sort_order ASC, created_at ASC, id LIMIT $2',
            [projectId, MAX_TASKS_LISTED],
        );
        return r.rows.map(rowToTask);
    }

    /**
     * Change some fields of a task. Only the keys present in `patch` are
     * touched; moving to `done` stamps `completedAt`, moving away clears it, and
     * a new due date starts the deadline reminders over. A change of column
     * puts the task at the end of that column (`moveTask` places it exactly).
     *
     * @param {string} projectId
     * @param {string} taskId
     * @param {{ title?: string, description?: string, labels?: string, checklist?: string, status?: string, priority?: string,
     *           assigneeIds?: string[], links?: object[], dueDate?: string|null }} patch
     */
    async function updateTask(projectId, taskId, patch) {
        await ready();
        const sets = [];
        const params = [taskId, projectId];
        const add = (col, value, cast = '') => { params.push(value); sets.push(`${col} = $${params.length}${cast}`); };
        if (patch.title !== undefined) add('title', patch.title);
        if (patch.description !== undefined) add('description', patch.description);
        if (patch.labels !== undefined) add('labels', patch.labels);
        if (patch.checklist !== undefined) add('checklist', patch.checklist);
        if (patch.priority !== undefined) {
            if (!PRIORITIES.includes(patch.priority)) throw new ProjectTaskStoreError('INVALID_PRIORITY', `priority must be one of ${PRIORITIES.join(', ')}`);
            add('priority', patch.priority);
        }
        if (patch.status !== undefined) {
            if (!STATUSES.includes(patch.status)) throw new ProjectTaskStoreError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`);
            const current = await getTask(projectId, taskId);
            if (current && current.status !== patch.status) add('sort_order', await endRank(projectId, patch.status));
            add('status', patch.status);
            sets.push(patch.status === 'done'
                ? 'completed_at = COALESCE(CASE WHEN status = \'done\' THEN completed_at END, NOW())'
                : 'completed_at = NULL');
        }
        if (patch.assigneeIds !== undefined) add('assignee_ids', JSON.stringify(patch.assigneeIds), '::jsonb');
        if (patch.links !== undefined) add('links', JSON.stringify(patch.links), '::jsonb');
        if (patch.dueDate !== undefined) {
            add('due_date', patch.dueDate || null);
            sets.push('notified_due_tier = NULL');
        }
        if (sets.length === 0) return getTask(projectId, taskId);
        const r = await db.query(
            `UPDATE project_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING *`,
            params,
        );
        return rowToTask(r.rows[0] || null);
    }

    /** Give the tasks of one column ranks RANK_STEP apart again, keeping their order. */
    async function renumber(projectId, status) {
        await db.query(
            `UPDATE project_tasks t SET sort_order = r.n * $3
               FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, created_at, id) AS n
                       FROM project_tasks WHERE project_id = $1 AND status = $2) r
              WHERE t.id = r.id`,
            [projectId, status, RANK_STEP],
        );
    }

    /**
     * Put a task in a column, right before `beforeId` (the end of the column
     * when none). Ranks leave room between neighbours; when there is none the
     * column is numbered again first.
     *
     * @returns {Promise<ReturnType<typeof rowToTask>|null>} null when the task, or the neighbour, is not in this project
     */
    async function moveTask(projectId, taskId, { status, beforeId = null }) {
        await ready();
        if (!STATUSES.includes(status)) throw new ProjectTaskStoreError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`);
        const task = await getTask(projectId, taskId);
        if (!task) return null;
        let rank;
        for (let attempt = 0; attempt < 2 && rank === undefined; attempt++) {
            if (!beforeId) { rank = await endRank(projectId, status); break; }
            const next = (await db.query('SELECT sort_order FROM project_tasks WHERE id = $1 AND project_id = $2 AND status = $3', [beforeId, projectId, status])).rows[0];
            if (!next) return null;
            const prev = (await db.query(
                'SELECT COALESCE(MAX(sort_order), 0) AS r FROM project_tasks WHERE project_id = $1 AND status = $2 AND sort_order < $3 AND id <> $4',
                [projectId, status, next.sort_order, taskId],
            )).rows[0];
            const high = Number(next.sort_order);
            const low = Number(prev.r);
            if (high - low > 1) rank = low + Math.floor((high - low) / 2);
            else await renumber(projectId, status);
        }
        if (rank === undefined) return null;
        const r = await db.query(
            `UPDATE project_tasks
                SET status = $3, sort_order = $4, updated_at = NOW(),
                    completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, NOW()) ELSE NULL END
              WHERE id = $1 AND project_id = $2 RETURNING *`,
            [taskId, projectId, status, rank],
        );
        return rowToTask(r.rows[0] || null);
    }

    /** The action items of a meeting that already became a task in this project: `itemId → taskId`. */
    async function tasksFromMeeting(projectId, meetingId) {
        await ready();
        const r = await db.query(
            `SELECT id, source->>'itemId' AS item FROM project_tasks WHERE project_id = $1 AND source->>'id' = $2`,
            [projectId, meetingId],
        );
        return new Map(r.rows.map((row) => [row.item, row.id]));
    }

    /** @returns {Promise<boolean>} whether a task was removed */
    async function deleteTask(projectId, taskId) {
        await ready();
        const r = await db.query('DELETE FROM project_tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
        return (r.rowCount || 0) > 0;
    }

    /**
     * Take one person off every task they hold in a project (they left it, or
     * were removed). Returns how many tasks changed.
     */
    async function unassignUser(projectId, userId) {
        await ready();
        const r = await db.query(
            `UPDATE project_tasks
                SET assignee_ids = assignee_ids - $2::text, updated_at = NOW()
              WHERE project_id = $1 AND assignee_ids ? $2::text`,
            [projectId, userId],
        );
        return r.rowCount || 0;
    }

    /** Tasks that point at a chat, thread of it, document or notebook go on existing; the link is dropped. */
    async function dropLinksTo(projectId, kind, id) {
        await ready();
        const r = await db.query(
            `UPDATE project_tasks
                SET links = COALESCE((SELECT jsonb_agg(l) FROM jsonb_array_elements(links) l
                                       WHERE NOT (l->>'kind' = $2 AND l->>'id' = $3)), '[]'::jsonb),
                    updated_at = NOW()
              WHERE project_id = $1 AND links @> jsonb_build_array(jsonb_build_object('kind', $2::text, 'id', $3::text))`,
            [projectId, kind, id],
        );
        return r.rowCount || 0;
    }

    return { createTask, getTask, listTasks, updateTask, moveTask, tasksFromMeeting, deleteTask, unassignUser, dropLinksTo };
}

const initDB = makeStoreInit('ProjectTaskStore', _initDB);

async function _initDB() {
    // The FK target is created first rather than assumed.
    await require('./projectStore').initDB();
    await exec(DDL);
    log.info('[ProjectTaskStore] PostgreSQL initialized');
}

const defaultStore = makeProjectTaskStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    STATUSES,
    LINK_KINDS,
    PRIORITIES,
    ProjectTaskStoreError,
    makeProjectTaskStore,
    rowToTask,
    ...defaultStore,
};

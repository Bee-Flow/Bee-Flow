// @typecheck strict
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
const { STATUSES, LINK_KINDS, PRIORITIES, RANK_STEP, ProjectTaskStoreError, rowToTask, makeRanks, makeBoard, makePoker } = require('./projectTaskStoreMakePoker');

const { DDL } = require('./projectTaskDdl');

/**
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} StoreDb
 */

/**
 * Update, move, delete and clean up tasks.
 * @param {StoreDb} db
 * @param {() => Promise<any>} ready
 * @param {(projectId: string, status: string) => Promise<number>} endRank
 * @param {(projectId: string, taskId: string) => Promise<any>} getTask
 */
function makeMutations(db, ready, endRank, getTask) {
    /**
     * Change some fields of a task. Only the keys present in `patch` are
     * touched; moving to `done` stamps `completedAt`, moving away clears it, and
     * a new due date starts the deadline reminders over. A change of column
     * puts the task at the end of that column (`moveTask` places it exactly).
     *
     * @param {string} projectId
     * @param {string} taskId
     * @param {{ title?: string, description?: string, labels?: string, checklist?: string, status?: string, priority?: string,
     *           assigneeIds?: string[], links?: object[], startDate?: string|null, dueDate?: string|null,
     *           itemType?: string, parentTaskId?: string|null, storyPoints?: number|null }} patch
     */
    async function updateTask(projectId, taskId, patch) {
        await ready();
        /** @type {string[]} */
        const sets = [];
        /** @type {unknown[]} */
        const params = [taskId, projectId];
        /**
         * @param {string} col
         * @param {unknown} value
         * @param {string} [cast]
         */
        const add = (col, value, cast = '') => { params.push(value); sets.push(`${col} = $${params.length}${cast}`); };
        if (patch.title !== undefined) add('title', patch.title);
        if (patch.description !== undefined) add('description', patch.description);
        if (patch.labels !== undefined) add('labels', patch.labels);
        if (patch.checklist !== undefined) add('checklist', patch.checklist);
        if (patch.priority !== undefined) {
            if (!PRIORITIES.includes(patch.priority)) throw new ProjectTaskStoreError('INVALID_PRIORITY', `priority must be one of ${PRIORITIES.join(', ')}`);
            add('priority', patch.priority);
        }
        if (patch.itemType !== undefined) {
            if (!['epic', 'story', 'user-story', 'task'].includes(patch.itemType)) throw new ProjectTaskStoreError('INVALID_ITEM_TYPE', 'itemType must be epic, story, user-story or task');
            add('item_type', patch.itemType);
        }
        if (patch.parentTaskId !== undefined) add('parent_task_id', patch.parentTaskId || null);
        if (patch.storyPoints !== undefined) {
            if (patch.storyPoints != null && ![1, 2, 3, 5, 8, 13, 21].includes(Number(patch.storyPoints))) throw new ProjectTaskStoreError('INVALID_STORY_POINTS', 'storyPoints must be a Fibonacci estimate');
            add('story_points', patch.storyPoints || null);
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
        if (patch.startDate !== undefined) add('start_date', patch.startDate || null);
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

    /**
     * Give the tasks of one column ranks RANK_STEP apart again, keeping their order.
     * @param {string} projectId
     * @param {string} status
     */
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
     * @param {string} projectId
     * @param {string} taskId
     * @param {{ status: string, beforeId?: string | null }} position
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

    /**
     * The action items of a meeting that already became a task in this project: `key → taskId`, where the
     * key is `itemId#textHash` (projects/taskFromMeeting itemKey), or the bare `itemId` for a task made
     * before the hash was kept. Look a key up with `itemKey` / `createdTaskFor`, not with the raw id.
     * @param {string} projectId
     * @param {string} meetingId
     */
    async function tasksFromMeeting(projectId, meetingId) {
        await ready();
        const r = await db.query(
            `SELECT id, source->>'itemId' AS item, source->>'textHash' AS hash
               FROM project_tasks WHERE project_id = $1 AND source->>'id' = $2`,
            [projectId, meetingId],
        );
        return new Map(r.rows.map((row) => [row.hash ? `${row.item}#${row.hash}` : row.item, row.id]));
    }

    /**
     * @returns {Promise<boolean>} whether a task was removed
     * @param {string} projectId
     * @param {string} taskId
     */
    async function deleteTask(projectId, taskId) {
        await ready();
        const r = await db.query('DELETE FROM project_tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
        return (r.rowCount || 0) > 0;
    }

    /**
     * Take one person off every task they hold in a project (they left it, or
     * were removed). Returns how many tasks changed.
     * @param {string} projectId
     * @param {string} userId
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

    /**
     * Tasks that point at a chat, thread of it, document, notebook or meeting go on existing; the link is
     * dropped. `projectId` null drops it in every project (the item itself was deleted).
     * @param {string | null} projectId
     * @param {string} id
     * @param {string} kind
     */
    async function dropLinksTo(projectId, kind, id) {
        await ready();
        const r = await db.query(
            `UPDATE project_tasks
                SET links = COALESCE((SELECT jsonb_agg(l) FROM jsonb_array_elements(links) l
                                       WHERE NOT (l->>'kind' = $2 AND l->>'id' = $3)), '[]'::jsonb),
                    updated_at = NOW()
              WHERE ($1::text IS NULL OR project_id = $1)
                AND links @> jsonb_build_array(jsonb_build_object('kind', $2::text, 'id', $3::text))`,
            [projectId || null, kind, id],
        );
        return r.rowCount || 0;
    }

    return { updateTask, moveTask, tasksFromMeeting, deleteTask, unassignUser, dropLinksTo };
}

/**
 * @param {StoreDb} db
 * @param {{ ready?: () => Promise<any> }} [opts]
 */
function makeProjectTaskStore(db, { ready = async () => {} } = {}) {
    const { endRank } = makeRanks(db);
    const board = makeBoard(db, ready, endRank);
    return {
        ...board,
        ...makeMutations(db, ready, endRank, board.getTask),
        ...makePoker(db, ready),
    };
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

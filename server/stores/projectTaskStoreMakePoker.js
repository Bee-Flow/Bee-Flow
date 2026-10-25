// @typecheck strict
/** @typedef {import('./projectTaskStore').StoreDb} StoreDb */

const STATUSES = Object.freeze(['todo', 'doing', 'done']);

const LINK_KINDS = Object.freeze(['document', 'notebook', 'chat', 'thread', 'meeting', 'task']);

const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

/** Room left between two neighbours in a column, so a move usually changes one row. */
const RANK_STEP = 1000;

/** The board shows every to-do and doing task; only the finished ones are cut, to the most recently completed. */
const MAX_DONE_LISTED = 500;

class ProjectTaskStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectTaskStoreError';
        this.code = code;
    }
}

/**
 * Where a task came from: `{ kind: 'meeting', id, itemId }`, or null. `textHash` (projects/taskFromMeeting
 * itemTextHash) pins which action item the positional `itemId` meant when the task was made; a task
 * from before it existed has none.
 * @param {unknown} v
 */
function parseSource(v) {
    const s = parseJson(v, null);
    if (!s || s.kind !== 'meeting' || typeof s.id !== 'string' || !s.id || typeof s.itemId !== 'string' || !s.itemId) return null;
    /** @type {{ kind: string, id: string, itemId: string, textHash?: string }} */
    const out = { kind: 'meeting', id: s.id, itemId: s.itemId };
    if (typeof s.textHash === 'string' && s.textHash) out.textHash = s.textHash;
    return out;
}

/**
 * @param {string | number | Date | null} v
 */
const toIso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * A DATE column as `YYYY-MM-DD`, whatever the driver made of it.
 * @param {string | number | Date | null} v
 */
const toDay = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    const d = new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * @param {unknown} v
 * @param {unknown} fallback
 */
function parseJson(v, fallback) {
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (_) { return fallback; }
    }
    return v == null ? fallback : v;
}

/**
 * @param {unknown} v
 */
function parseAssignees(v) {
    const list = parseJson(v, []);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
}

/**
 * `{ kind, id }`, plus `chatId` for a thread (the chat the thread lives in). Nothing else is kept.
 * @param {unknown} v
 */
function parseLinks(v) {
    const list = parseJson(v, []);
    if (!Array.isArray(list)) return [];
    return list
        .filter((x) => x && LINK_KINDS.includes(x.kind) && typeof x.id === 'string' && x.id)
        .map((x) => (x.kind === 'thread' ? { kind: 'thread', id: x.id, chatId: String(x.chatId || '') } : { kind: x.kind, id: x.id, ...(x.kind === 'task' && x.relation === 'depends_on' ? { relation: x.relation } : {}) }));
}

/**
 * A task row as stored. `title` and `description` are still sealed.
 * @param {DbRow.ProjectTasks | null} r
 */
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
        startDate: toDay(r.start_date),
        dueDate: toDay(r.due_date),
        priority: r.priority || 'normal',
        itemType: r.item_type || 'task',
        parentTaskId: r.parent_task_id || null,
        storyPoints: r.story_points == null ? null : Number(r.story_points),
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
 * The rank that puts a task at the end of a column.
 * @param {StoreDb} db
 */
function makeRanks(db) {
    /**
     * The rank that puts a task at the end of a column.
     * @param {string} projectId
     * @param {string} status
     */
    async function endRank(projectId, status) {
        const r = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS top FROM project_tasks WHERE project_id = $1 AND status = $2', [projectId, status]);
        return Number(r.rows[0].top) + RANK_STEP;
    }

    return { endRank };
}

/**
 * Create and read tasks.
 * @param {StoreDb} db
 * @param {() => Promise<any>} ready
 * @param {(projectId: string, status: string) => Promise<number>} endRank
 */
function makeBoard(db, ready, endRank) {
    /**
     * @param {{ id: string, projectId: string, title: string, description: string, createdBy: string,
     *           status?: string, priority?: string, labels?: string, checklist?: string, assigneeIds?: string[],
     *           links?: object[], startDate?: string|null, dueDate?: string|null, source?: object|null,
     *           itemType?: string, parentTaskId?: string|null, storyPoints?: number|null }} t  title, description, labels and checklist sealed
     * @returns {Promise<ReturnType<typeof rowToTask>|null>} null when the meeting item of `source` already became a task here
     */
    async function createTask(t) {
        await ready();
        const status = t.status || 'todo';
        if (!STATUSES.includes(status)) throw new ProjectTaskStoreError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`);
        const priority = t.priority || 'normal';
        if (!PRIORITIES.includes(priority)) throw new ProjectTaskStoreError('INVALID_PRIORITY', `priority must be one of ${PRIORITIES.join(', ')}`);
        const itemType = t.itemType || 'task';
        if (!['epic', 'story', 'user-story', 'task'].includes(itemType)) throw new ProjectTaskStoreError('INVALID_ITEM_TYPE', 'itemType must be epic, story, user-story or task');
        if (t.storyPoints != null && ![1, 2, 3, 5, 8, 13, 21].includes(Number(t.storyPoints))) throw new ProjectTaskStoreError('INVALID_STORY_POINTS', 'storyPoints must be a Fibonacci estimate');
        const r = await db.query(
            `INSERT INTO project_tasks
                (id, project_id, title, description, status, assignee_ids, links, due_date, created_by, completed_at,
                 priority, labels, checklist, sort_order, source, start_date, item_type, parent_task_id, story_points)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [t.id, t.projectId, t.title, t.description, status, JSON.stringify(t.assigneeIds || []), JSON.stringify(t.links || []),
                t.dueDate || null, t.createdBy, status === 'done' ? new Date() : null,
                priority, t.labels || '', t.checklist || '', await endRank(t.projectId, status), t.source ? JSON.stringify(t.source) : null, t.startDate || null,
                itemType, t.parentTaskId || null, t.storyPoints || null],
        );
        return rowToTask(r.rows[0] || null);
    }

    /**
     * One task, only when it belongs to this project.
     * @param {string} projectId
     * @param {string} taskId
     */
    async function getTask(projectId, taskId) {
        await ready();
        const r = await db.query('SELECT * FROM project_tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
        return rowToTask(r.rows[0] || null);
    }

    /**
     * The board: every to-do and doing task, and the most recently finished ones (older done tasks are
     * left out, `truncated` says so). In board order (rank), newest last within a column.
     * @param {string} projectId
     */
    async function listBoard(projectId) {
        await ready();
        const r = await db.query(
            `SELECT * FROM (
                 SELECT p.*, NULL::bigint AS recent FROM project_tasks p WHERE p.project_id = $1 AND p.status <> 'done'
                 UNION ALL
                 (SELECT p.*, ROW_NUMBER() OVER (ORDER BY p.completed_at DESC NULLS LAST, p.created_at DESC, p.id) AS recent
                    FROM project_tasks p WHERE p.project_id = $1 AND p.status = 'done'
                   ORDER BY p.completed_at DESC NULLS LAST, p.created_at DESC, p.id LIMIT $2)
             ) b ORDER BY sort_order ASC, created_at ASC, id`,
            [projectId, MAX_DONE_LISTED + 1],
        );
        // The one extra finished row only proves there are more.
        const shown = r.rows.filter((row) => row.recent == null || Number(row.recent) <= MAX_DONE_LISTED);
        return { tasks: shown.map(rowToTask), truncated: shown.length < r.rows.length };
    }

    /**
     * @param {string} projectId
     */
    async function listSearchTasks(projectId) {
        await ready();
        return (await db.query('SELECT * FROM project_tasks WHERE project_id = $1 ORDER BY id', [projectId])).rows.map(rowToTask);
    }

    /**
     * The project's tasks as listBoard returns them, without the `truncated` flag.
     * @param {string} projectId
     */
    async function listTasks(projectId) {
        return (await listBoard(projectId)).tasks;
    }

    return { createTask, getTask, listBoard, listSearchTasks, listTasks };
}

/**
 * Planning poker sessions.
 * @param {StoreDb} db
 * @param {() => Promise<any>} ready
 */
function makePoker(db, ready) {
    /**
     * @param {import('pg').QueryResultRow | null} row
     */
    function pokerRow(row) {
        if (!row) return null;
        const queue = parseJson(row.queue, []);
        return { projectId: row.project_id, sessionId: row.session_id, taskId: row.task_id, phase: row.phase,
            votes: parseJson(row.votes, {}), queue: Array.isArray(queue) ? queue.filter((x) => typeof x === 'string' && x) : [],
            startedBy: row.started_by, updatedAt: toIso(row.updated_at) };
    }

    /**
     * @param {string} projectId
     */
    async function getPokerSession(projectId) {
        await ready();
        const r = await db.query('SELECT * FROM project_task_poker WHERE project_id = $1', [projectId]);
        return pokerRow(r.rows[0]);
    }

    /**
     * Open a session on `taskId`, with the rest of the list queued behind it (an empty
     * queue for the one-task session older callers start). Only when no session is running.
     * @param {string} projectId
     * @param {string} sessionId
     * @param {string} taskId
     * @param {string} userId
     * @param {string[]} [queue]
     */
    async function startPokerSession(projectId, sessionId, taskId, userId, queue = []) {
        await ready();
        const r = await db.query(
            `INSERT INTO project_task_poker (project_id, session_id, task_id, phase, votes, queue, started_by, updated_at)
             VALUES ($1, $2, $3, 'voting', '{}'::jsonb, $5::jsonb, $4, NOW())
             ON CONFLICT (project_id) DO UPDATE SET session_id = EXCLUDED.session_id, task_id = EXCLUDED.task_id,
                 phase = 'voting', votes = '{}'::jsonb, queue = EXCLUDED.queue, started_by = EXCLUDED.started_by, updated_at = NOW()
             WHERE project_task_poker.phase IN ('completed', 'cancelled') RETURNING *`,
            [projectId, sessionId, taskId, userId, JSON.stringify(queue)],
        );
        return pokerRow(r.rows[0]);
    }

    /**
     * @param {string} projectId
     * @param {string} sessionId
     * @param {string} userId
     * @param {string} vote
     */
    async function castPokerVote(projectId, sessionId, userId, vote) {
        await ready();
        const r = await db.query(
            `UPDATE project_task_poker SET votes = votes || jsonb_build_object($3::text, to_jsonb($4::text)), updated_at = NOW()
              WHERE project_id = $1 AND session_id = $2 AND phase = 'voting' RETURNING *`, [projectId, sessionId, userId, vote],
        );
        return pokerRow(r.rows[0]);
    }

    /**
     * @param {string} projectId
     * @param {string} sessionId
     */
    async function revealPokerVotes(projectId, sessionId) {
        await ready();
        const r = await db.query(`UPDATE project_task_poker SET phase = 'revealed', updated_at = NOW()
             WHERE project_id = $1 AND session_id = $2 AND phase = 'voting' RETURNING *`, [projectId, sessionId]);
        return pokerRow(r.rows[0]);
    }

    /**
     * @param {string} projectId
     * @param {string} sessionId
     * @param {number | null} points
     */
    async function finishPokerSession(projectId, sessionId, points) {
        await ready();
        const r = await db.query(
            `WITH ended AS (
                UPDATE project_task_poker SET phase = 'completed', updated_at = NOW()
                 WHERE project_id = $1 AND session_id = $2 AND phase = 'revealed' RETURNING task_id
             )
             UPDATE project_tasks SET story_points = $3, updated_at = NOW()
               FROM ended WHERE project_tasks.id = ended.task_id AND project_tasks.project_id = $1 RETURNING project_tasks.*`,
            [projectId, sessionId, points],
        );
        return rowToTask(r.rows[0] || null);
    }

    /**
     * @param {string} projectId
     * @param {string} sessionId
     */
    async function cancelPokerSession(projectId, sessionId) {
        await ready();
        const r = await db.query(`UPDATE project_task_poker SET phase = 'cancelled', updated_at = NOW()
             WHERE project_id = $1 AND session_id = $2 AND phase IN ('voting', 'revealed') RETURNING *`, [projectId, sessionId]);
        return pokerRow(r.rows[0]);
    }

    /**
     * Save the agreed estimate on the current task and move the queue on: the next
     * queued task becomes the one being voted on (fresh votes), or the session is
     * `completed` when the queue was empty. One statement, so the estimate and the
     * advance never land apart. Null when the session is not waiting on a reveal.
     *
     * @returns {Promise<{ task: ReturnType<typeof rowToTask>, session: ReturnType<typeof pokerRow> }|null>}
     * @param {string} projectId
     * @param {string} sessionId
     * @param {number | null} points
     */
    async function advancePokerSession(projectId, sessionId, points) {
        await ready();
        const r = await db.query(
            `WITH cur AS (
                 SELECT task_id, queue FROM project_task_poker
                  WHERE project_id = $1 AND session_id = $2 AND phase = 'revealed'
             ), scored AS (
                 UPDATE project_tasks t SET story_points = $3, updated_at = NOW()
                   FROM cur WHERE t.id = cur.task_id AND t.project_id = $1
                 RETURNING t.*
             ), nxt AS (
                 UPDATE project_task_poker p
                    SET task_id    = CASE WHEN jsonb_array_length(cur.queue) > 0 THEN cur.queue->>0 ELSE p.task_id END,
                        queue      = CASE WHEN jsonb_array_length(cur.queue) > 0 THEN cur.queue - 0 ELSE '[]'::jsonb END,
                        phase      = CASE WHEN jsonb_array_length(cur.queue) > 0 THEN 'voting' ELSE 'completed' END,
                        votes      = '{}'::jsonb,
                        updated_at = NOW()
                   FROM cur
                  WHERE p.project_id = $1 AND p.session_id = $2 AND p.phase = 'revealed'
                 RETURNING p.*
             )
             SELECT (SELECT to_jsonb(s) FROM scored s) AS task, (SELECT to_jsonb(x) FROM nxt x) AS session`,
            [projectId, sessionId, points],
        );
        const row = r.rows[0];
        if (!row || !row.session) return null;
        return { task: rowToTask(row.task), session: pokerRow(row.session) };
    }

    return { getPokerSession, startPokerSession, castPokerVote, revealPokerVotes, finishPokerSession, cancelPokerSession, advancePokerSession };
}

module.exports = { STATUSES, LINK_KINDS, PRIORITIES, RANK_STEP, ProjectTaskStoreError, rowToTask, makeRanks, makeBoard, makePoker };

// @typecheck
/**
 * Tasks inside a project: to do, doing, done; given to members; with a
 * description and links to documents, notebooks, team chats and threads.
 * Mounted under /api/projects (the mount carries requireAuthedUser).
 *
 * GET    /:id/tasks             viewer   every task of the project, newest first
 * POST   /:id/tasks             editor   make a task
 * PATCH  /:id/tasks/:taskId     editor   change any field (status, people, links, ...)
 * DELETE /:id/tasks/:taskId     editor   the one who made it, or the project owner
 * POST   /:id/tasks/batch       editor   make up to 50 tasks at once (from a meeting's action items)
 * POST   /:id/meetings/:meetingId/task-suggestions/improve   editor   the AI expands a meeting's action items (also the ones already made into tasks): description, priority, labels, checklist, and who, when plain
 * POST   /:id/tasks/:taskId/improve   editor   the AI's suggestion to improve one task (nothing is saved)
 * GET    /:id/meetings/:meetingId/task-suggestions   viewer   a meeting's action items as task suggestions
 *
 * Titles, descriptions, labels and checklists are sealed with the project key (projects/chatCrypto.js,
 * the task id in the place of the chat id) and opened on the way out; a key that
 * cannot be produced is a 503 and nothing is stored in plaintext. One task that
 * will not open is served with an empty title and `unreadable: true`.
 *
 * Assignees must be members of the project. A link must point at something
 * that is in this project: a document, notebook or meeting filed in it, a chat of it, or
 * a message of that chat that starts a thread. A Studio Solution holds no tasks.
 *
 * Live feed: task.created / task.updated / task.deleted `{taskId}`, and
 * task.assigned `{taskId, assigneeIds}` for people newly given a task. Never
 * content. The activity log records task.created and task.deleted.
 *
 * Built by a factory so the test hands in the store, key and role gate.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { badRequest, forbidden, notFound, conflict } = require('../../core/http/errors');
const S = require('./taskSchemas');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => Express middleware
 * @param {Function} [deps.getProjectRole]      (userId, projectId) => role|null
 * @param {Function} [deps.getProject]          (id) => project row
 * @param {object}   [deps.store]               stores/projectTaskStore surface
 * @param {object}   [deps.chatStore]           stores/projectChatStore surface, for chat and thread links
 * @param {object}   [deps.chatCrypto]          { forProject(project, { what }) }
 * @param {object}   [deps.assistant]          projects/taskAssistant surface: forMeeting, forTask
 * @param {Function} [deps.resolveOrgs]         (req) => { orgId, limitOrgId } for the asker's model tier and limits
 * @param {Function} [deps.improveLimiter]      Express middleware on the AI routes
 * @param {object}   [deps.notifier]           projects/taskNotify surface: assigned({project, actorId, assigneeIds, taskId}), the bell for a task given to someone
 * @param {object}   [deps.commentStore]       stores/projectCommentStore surface: deleteForTarget, so a deleted task takes its comment threads with it
 * @param {Function} [deps.readMeeting]         (req, project, meetingId) => the meeting note (with `actionItems`) when it is filed in this project, else null
 * @param {Function} [deps.listPeople]          (project) => [{ id, name }] the members that can be given a task
 * @param {Function} [deps.filedIds]            (projectId, kind) => Set of ids filed in the project
 * @param {Function} [deps.emit]                (projectId, event) => durable event
 * @param {Function} [deps.logActivity]         (projectId, actorId, action, details)
 * @param {Function} [deps.newId]
 */
function makeProjectTasksRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const getProjectRole = deps.getProjectRole
        || ((userId, projectId) => require('../../auth/projectAccess').getProjectRole(userId, projectId));
    const getProject = deps.getProject || ((id) => require('../../stores/projectStore').getProject(id));
    const store = () => deps.store || require('../../stores/projectTaskStore');
    const chatStore = () => deps.chatStore || require('../../stores/projectChatStore');
    const chatCrypto = () => deps.chatCrypto || require('../../projects/chatCrypto');
    const filedIds = deps.filedIds || (async (projectId, kind) => {
        const entry = require('../../projects/membership').getKind(kind);
        const rows = entry ? await entry.list(projectId) : [];
        return new Set((rows || []).map((r) => r.id));
    });
    let defaultAssistant = null;
    const assistant = () => deps.assistant || (defaultAssistant || (defaultAssistant = require('../../projects/taskAssistant').makeTaskAssistant()));
    const resolveOrgs = deps.resolveOrgs || (async (req) => {
        const userId = req.session.user.id;
        const orgId = await require('../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
        const limitOrgId = await require('../../core/entitlements/limits').resolveOrgId(req);
        return { orgId: orgId || null, limitOrgId: limitOrgId || null };
    });
    let defaultLimiter = null;
    const improveLimiter = deps.improveLimiter || function rateLimitMiddleware(req, res, next) {
        if (!defaultLimiter) {
            defaultLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 20, name: 'project-task-ai' });
        }
        return defaultLimiter(req, res, next);
    };
    const notifier = () => deps.notifier || require('../../projects/taskNotify').makeTaskNotifier();
    const commentStore = () => deps.commentStore || require('../../stores/projectCommentStore');
    const readMeeting = deps.readMeeting || (async (req, project, meetingId) => {
        const { resolveAccessContext } = require('../transcriptions/shared');
        const note = await require('../../stores/transcriptionStore').getTranscription(meetingId, userIdOf(req), await resolveAccessContext(req));
        return note && note.projectId === project.id ? note : null;
    });
    const listPeople = deps.listPeople || (async (project) => {
        const { displayNameOf } = require('../../core/documents/documentPeople');
        const shares = await require('../../stores/projectStore').getProjectShares(project.id);
        const ids = [...new Set([project.ownerId, ...shares.filter((x) => x.sharedWithType === 'user').map((x) => x.sharedWithId)].filter(Boolean))];
        const people = [];
        for (const id of ids) {
            try {
                const user = await require('../../stores/userStore').getUser(id);
                const name = user && (user.organizationId || '') === (project.organizationId || '') ? displayNameOf(user) : '';
                if (name) people.push({ id, name });
            } catch (err) { log.warn(`[ProjectTasks] member lookup failed: ${err && err.message}`); }
        }
        return people;
    });
    const emit = deps.emit
        || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectTasks' }));
    const logActivity = deps.logActivity
        || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details));
    const newId = deps.newId || (() => crypto.randomUUID());
    const userIdOf = (req) => req.session.user.id;

    async function loadProject(req) {
        const project = await getProject(req.params.id);
        if (!project) throw notFound('not_found', 'Not found');
        if (project.kind === 'solution') {
            throw conflict('SOLUTION_HOLDS_NO_TASKS', 'A Studio Solution holds no tasks. Add the task to a project instead.');
        }
        return project;
    }

    async function loadTask(project, taskId) {
        const task = await store().getTask(project.id, taskId);
        if (!task) throw notFound('task_not_found', 'This task does not exist in this project.');
        return task;
    }

    const taskEvent = (kind, actorId, taskId, payload = {}) => ({
        kind, actorId, targetType: 'project_task', targetId: taskId, payload: { taskId, ...payload },
    });

    async function audit(projectId, actorId, action, taskId) {
        try {
            await logActivity(projectId, actorId, action, { targetType: 'project_task', targetId: taskId });
        } catch (err) {
            log.warn(`[ProjectTasks] activity not recorded (${action}): ${err && err.message}`);
        }
    }

    function open(fn, what) {
        try {
            return { text: fn(), ok: true };
        } catch (err) {
            log.error(`[ProjectTasks] ${what} could not be decrypted: ${err && err.code}`);
            return { text: '', ok: false };
        }
    }

    /** Labels and the checklist are sealed JSON; a row from before they existed holds neither. */
    const openList = (t, field, box) => (t[field]
        ? open(() => JSON.parse(box.openContent(t.id, `${t.id}:${field}`, t[field])), `${field} of task ${t.id}`)
        : { text: [], ok: true });

    function presentTask(box, t) {
        const title = open(() => box.openTitle(t.id, t.title), `title of task ${t.id}`);
        const description = open(() => box.openContent(t.id, t.id, t.description), `description of task ${t.id}`);
        const labels = openList(t, 'labels', box);
        const checklist = openList(t, 'checklist', box);
        const out = {
            id: t.id,
            title: title.text,
            description: description.text,
            status: t.status,
            priority: t.priority,
            labels: labels.ok ? labels.text : [],
            checklist: checklist.ok ? checklist.text : [],
            sortOrder: t.sortOrder,
            source: t.source,
            assigneeIds: t.assigneeIds,
            links: t.links,
            dueDate: t.dueDate,
            createdBy: t.createdBy,
            completedAt: t.completedAt,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
        };
        if (!title.ok || !description.ok || !labels.ok || !checklist.ok) out.unreadable = true;
        return out;
    }

    const sealList = (box, id, field, list) => box.sealContent(id, `${id}:${field}`, JSON.stringify(list));

    /** Assignees must be on the project right now. */
    async function checkedAssignees(projectId, ids) {
        const unique = [...new Set(ids || [])];
        for (const id of unique) {
            let role = null;
            try { role = await getProjectRole(id, projectId); } catch (_) { /* unknown is not a member */ }
            if (!role) throw badRequest('assignee_not_member', 'You can only give a task to a member of this project.');
        }
        return unique;
    }

    /** Every link must point into this project. */
    async function checkedLinks(projectId, links) {
        const kept = [];
        for (const l of links || []) {
            if (kept.some((k) => k.kind === l.kind && k.id === l.id)) continue;
            kept.push(l.kind === 'thread' ? { kind: 'thread', id: l.id, chatId: l.chatId } : { kind: l.kind, id: l.id });
        }
        for (const kind of ['document', 'notebook', 'meeting']) {
            const wanted = kept.filter((l) => l.kind === kind);
            if (wanted.length === 0) continue;
            const filed = await filedIds(projectId, kind);
            if (wanted.some((l) => !filed.has(l.id))) {
                throw badRequest('link_not_in_project', 'You can only link documents, notebooks, meetings, chats and threads of this project.');
            }
        }
        for (const l of kept) {
            if (l.kind === 'chat') {
                if (!(await chatStore().getChat(projectId, l.id))) throw badRequest('link_not_in_project', 'You can only link documents, notebooks, meetings, chats and threads of this project.');
            } else if (l.kind === 'thread') {
                const chat = await chatStore().getChat(projectId, l.chatId);
                const root = chat ? await chatStore().getMessage(chat.id, l.id) : null;
                if (!root || root.threadId || root.deletedAt) throw badRequest('link_not_in_project', 'You can only link documents, notebooks, meetings, chats and threads of this project.');
            }
        }
        return kept;
    }

    router.get('/:id/tasks', requireRole('viewer'), async (req, res) => {
        const project = await loadProject(req);
        const box = await chatCrypto().forProject(project, { what: 'Tasks' });
        const tasks = await store().listTasks(project.id);
        res.json({ tasks: tasks.map((t) => presentTask(box, t)), role: req.projectRole });
    });

    /** Validate one task's people and links, and shape the row to store (sealed). Nothing is written. */
    async function prepareTask(project, box, userId, input) {
        const assigneeIds = await checkedAssignees(project.id, input.assigneeIds);
        const links = await checkedLinks(project.id, input.links);
        const id = newId();
        return {
            row: {
                id,
                projectId: project.id,
                title: box.sealTitle(id, input.title.trim()),
                description: box.sealContent(id, id, input.description || ''),
                labels: input.labels && input.labels.length ? sealList(box, id, 'labels', [...new Set(input.labels)]) : '',
                checklist: input.checklist && input.checklist.length ? sealList(box, id, 'checklist', input.checklist) : '',
                status: input.status || 'todo',
                priority: input.priority || 'normal',
                assigneeIds,
                links,
                dueDate: input.dueDate || null,
                source: input.source || null,
                createdBy: userId,
            },
            assigneeIds,
        };
    }

    /** The live feed, and the bell of everyone newly given the task. */
    async function announceAssigned(project, actorId, taskId, assigneeIds) {
        await emit(project.id, taskEvent('task.assigned', actorId, taskId, { assigneeIds }));
        await notifier().assigned({ project, actorId, assigneeIds, taskId });
    }

    async function announceCreated(project, userId, task, assigneeIds) {
        await audit(project.id, userId, 'task.created', task.id);
        await emit(project.id, taskEvent('task.created', userId, task.id));
        if (assigneeIds.length) await announceAssigned(project, userId, task.id, assigneeIds);
    }

    router.post('/:id/tasks', requireRole('editor'), validate({ body: S.CreateTaskBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const box = await chatCrypto().forProject(project, { what: 'Tasks' });
        const { row, assigneeIds } = await prepareTask(project, box, userId, req.body);
        const task = await store().createTask(row);
        await announceCreated(project, userId, task, assigneeIds);
        res.status(201).json({ task: presentTask(box, task) });
    });

    // Everything is checked before anything is stored, so a refusal leaves no half a list. A task whose
    // `source` already became a task here is skipped: the same meeting item is never made twice.
    router.post('/:id/tasks/batch', requireRole('editor'), validate({ body: S.BatchTasksBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const box = await chatCrypto().forProject(project, { what: 'Tasks' });
        const made = new Map();
        const prepared = [];
        let skipped = 0;
        for (const input of req.body.items) {
            if (input.source) {
                if (!made.has(input.source.id)) made.set(input.source.id, await store().tasksFromMeeting(project.id, input.source.id));
                if (made.get(input.source.id).has(input.source.itemId)) { skipped += 1; continue; }
                made.get(input.source.id).set(input.source.itemId, 'pending');
            }
            const links = [...(input.links || [])];
            if (input.source && !links.some((l) => l.kind === 'meeting' && l.id === input.source.id)) links.push({ kind: 'meeting', id: input.source.id });
            prepared.push(await prepareTask(project, box, userId, { ...input, links }));
        }
        const tasks = [];
        for (const { row, assigneeIds } of prepared) {
            const task = await store().createTask(row);
            await announceCreated(project, userId, task, assigneeIds);
            tasks.push(presentTask(box, task));
        }
        res.status(201).json({ tasks, skipped });
    });

    router.get('/:id/meetings/:meetingId/task-suggestions', requireRole('viewer'), async (req, res) => {
        const project = await loadProject(req);
        if (!(await filedIds(project.id, 'meeting')).has(req.params.meetingId)) {
            throw notFound('meeting_not_found', 'This meeting is not filed in this project.');
        }
        const note = await readMeeting(req, project, req.params.meetingId);
        if (!note) throw notFound('meeting_not_found', 'This meeting is not filed in this project.');
        const { suggestionsFromNote } = require('../../projects/taskFromMeeting');
        const created = await store().tasksFromMeeting(project.id, note.id);
        res.json({
            meeting: { id: note.id, title: note.title || '' },
            suggestions: suggestionsFromNote(note, await listPeople(project), created),
        });
    });

    // The AI reads the notes as the asker and only suggests: nothing is made here.
    router.post('/:id/meetings/:meetingId/task-suggestions/improve', requireRole('editor'), improveLimiter, async (req, res) => {
        const project = await loadProject(req);
        if (!(await filedIds(project.id, 'meeting')).has(req.params.meetingId)) throw notFound('meeting_not_found', 'This meeting is not filed in this project.');
        const note = await readMeeting(req, project, req.params.meetingId);
        if (!note) throw notFound('meeting_not_found', 'This meeting is not filed in this project.');
        // Items that already became a task are expanded too: the person can let the AI improve the task that exists.
        const created = await store().tasksFromMeeting(project.id, note.id);
        const items = (Array.isArray(note.actionItems) ? note.actionItems : [])
            .filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string' && i.text.trim());
        const orgs = await resolveOrgs(req);
        const improved = await assistant().forMeeting({ project, userId: userIdOf(req), ...orgs, note, items, people: await listPeople(project) });
        res.json({ items: improved.map((i) => ({ ...i, createdTaskId: created.get(i.itemId) || null })) });
    });

    router.post('/:id/tasks/:taskId/improve', requireRole('editor'), improveLimiter, async (req, res) => {
        const project = await loadProject(req);
        const task = await loadTask(project, req.params.taskId);
        const box = await chatCrypto().forProject(project, { what: 'Tasks' });
        const shown = presentTask(box, task);
        if (shown.unreadable) throw conflict('task_unreadable', 'This task could not be read, so it cannot be improved.');
        const orgs = await resolveOrgs(req);
        const suggestion = await assistant().forTask({ project, userId: userIdOf(req), ...orgs, task: shown, people: await listPeople(project) });
        res.json({ suggestion });
    });

    router.patch('/:id/tasks/:taskId', requireRole('editor'), validate({ body: S.UpdateTaskBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const task = await loadTask(project, req.params.taskId);
        const box = await chatCrypto().forProject(project, { what: 'Tasks' });
        const { title, description, status, dueDate, priority, beforeId } = req.body;
        const patch = {};
        if (title !== undefined) patch.title = box.sealTitle(task.id, title.trim());
        if (description !== undefined) patch.description = box.sealContent(task.id, task.id, description);
        if (priority !== undefined) patch.priority = priority;
        if (dueDate !== undefined) patch.dueDate = dueDate;
        if (req.body.labels !== undefined) patch.labels = req.body.labels.length ? sealList(box, task.id, 'labels', [...new Set(req.body.labels)]) : '';
        if (req.body.checklist !== undefined) patch.checklist = req.body.checklist.length ? sealList(box, task.id, 'checklist', req.body.checklist) : '';
        // A move names the column and where in it; a plain status change goes to the end of its column.
        const moves = beforeId !== undefined;
        if (status !== undefined && !moves) patch.status = status;
        let added = [];
        if (req.body.assigneeIds !== undefined) {
            patch.assigneeIds = await checkedAssignees(project.id, req.body.assigneeIds);
            added = patch.assigneeIds.filter((id) => !task.assigneeIds.includes(id));
        }
        if (req.body.links !== undefined) patch.links = await checkedLinks(project.id, req.body.links);
        let updated = await store().updateTask(project.id, task.id, patch);
        if (moves && updated) {
            updated = await store().moveTask(project.id, task.id, { status: status || task.status, beforeId });
            if (!updated) throw badRequest('move_target_not_found', 'beforeId must be a task in the column the task moves to.');
        }
        if (!updated) throw notFound('task_not_found', 'This task does not exist in this project.');
        await emit(project.id, taskEvent('task.updated', userId, task.id));
        if (added.length) await announceAssigned(project, userId, task.id, added);
        res.json({ task: presentTask(box, updated) });
    });

    router.delete('/:id/tasks/:taskId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const task = await loadTask(project, req.params.taskId);
        if (task.createdBy !== userId && req.projectRole !== 'owner') {
            throw forbidden('not_task_author', 'Only the person who made this task, or the project owner, can delete it.');
        }
        await store().deleteTask(project.id, task.id);
        try {
            await commentStore().deleteForTarget('task', task.id);
        } catch (err) {
            log.warn(`[ProjectTasks] comment threads of task ${task.id} not removed: ${err && err.message}`);
        }
        await audit(project.id, userId, 'task.deleted', task.id);
        await emit(project.id, taskEvent('task.deleted', userId, task.id));
        res.json({ ok: true });
    });

    return router;
}

const router = makeProjectTasksRouter();

module.exports = router;
module.exports.makeProjectTasksRouter = makeProjectTasksRouter;

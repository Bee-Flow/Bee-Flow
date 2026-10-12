// @typecheck
/**
 * Sprints inside a project: named time boxes the team fills with tasks,
 * estimates in planning poker, starts and completes. One sprint per project
 * is active at a time. Mounted under /api/projects (the mount carries
 * requireAuthedUser).
 *
 * GET    /:id/sprints                          viewer   the project's sprints, each with its task rollup (itemCount, pointsTotal, pointsDone, doneCount)
 * POST   /:id/sprints                          editor   make a sprint
 * PATCH  /:id/sprints/:sprintId                editor   change name, goal, dates or capacity
 * DELETE /:id/sprints/:sprintId                editor   the sprint goes; its tasks keep existing with no sprint
 * POST   /:id/sprints/:sprintId/items          editor   put tasks of the project into the sprint
 * DELETE /:id/sprints/:sprintId/items/:taskId  editor   take one task out
 * POST   /:id/sprints/:sprintId/start          editor   make it the active sprint (the one that was goes back to planned); a closed one is 409
 * POST   /:id/sprints/:sprintId/complete       editor   close the active sprint; a planned or closed one is 409
 *
 * A closed sprint is history: it is not started again and takes no new tasks
 * (409 sprint_closed).
 *
 * Names and goals are sealed with the project key (projects/chatCrypto.js,
 * the sprint id in the place of the chat id) and opened on the way out; a key
 * that cannot be produced is a 503 and nothing is stored in plaintext. One
 * sprint that will not open is served with an empty name and
 * `unreadable: true`.
 *
 * Live feed: sprint.created / sprint.updated / sprint.deleted `{sprintId}`.
 * Never content. The activity log records sprint.created and sprint.deleted.
 *
 * Built by a factory so the test hands in the store, key and role gate.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { projectAccessDeps } = require('./roleGate');
const { badRequest, notFound, conflict } = require('../../core/http/errors');
const S = require('./sprintSchemas');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => Express middleware
 * @param {Function} [deps.getProjectRole]      (userId, projectId) => role|null
 * @param {Function} [deps.getProject]          (id) => project row
 * @param {object}   [deps.store]               stores/projectSprintStore surface
 * @param {object}   [deps.taskStore]           stores/projectTaskStore surface, for the tasks a sprint holds
 * @param {object}   [deps.chatCrypto]          { forProject(project, { what }) }
 * @param {Function} [deps.emit]                (projectId, event) => durable event
 * @param {Function} [deps.logActivity]         (projectId, actorId, action, details)
 * @param {Function} [deps.newId]
 */
function makeProjectSprintsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const { requireRole, getProject } = projectAccessDeps(deps);
    const store = () => deps.store || require('../../stores/projectSprintStore');
    const taskStore = () => deps.taskStore || require('../../stores/projectTaskStore');
    const chatCrypto = () => deps.chatCrypto || require('../../projects/chatCrypto');
    const emit = deps.emit
        || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectSprints' }));
    const logActivity = deps.logActivity
        || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details));
    const newId = deps.newId || (() => crypto.randomUUID());
    const userIdOf = (req) => req.session.user.id;

    async function loadProject(req) {
        const project = await getProject(req.params.id);
        if (!project) throw notFound('not_found', 'Not found');
        if (project.kind === 'solution') {
            throw conflict('SOLUTION_HOLDS_NO_SPRINTS', 'A Studio Solution holds no sprints. Plan the sprint in a project instead.');
        }
        return project;
    }

    async function loadSprint(project, sprintId) {
        const sprint = await store().getSprint(project.id, sprintId);
        if (!sprint) throw notFound('sprint_not_found', 'This sprint does not exist in this project.');
        return sprint;
    }

    const closedError = () => conflict('sprint_closed', 'This sprint is completed. Plan a new sprint instead.');
    const notActiveError = () => conflict('sprint_not_active', 'Only the active sprint can be completed. Start it first.');

    const sprintEvent = (kind, actorId, sprintId, payload = {}) => ({
        kind, actorId, targetType: 'project_sprint', targetId: sprintId, payload: { sprintId, ...payload },
    });

    async function audit(projectId, actorId, action, sprintId) {
        try {
            await logActivity(projectId, actorId, action, { targetType: 'project_sprint', targetId: sprintId });
        } catch (err) {
            log.warn(`[ProjectSprints] activity not recorded (${action}): ${err && err.message}`);
        }
    }

    function open(fn, what) {
        try {
            return { text: fn(), ok: true };
        } catch (err) {
            log.error(`[ProjectSprints] ${what} could not be decrypted: ${err && err.code}`);
            return { text: '', ok: false };
        }
    }

    function presentSprint(box, s) {
        const name = open(() => box.openTitle(s.id, s.name), `name of sprint ${s.id}`);
        const goal = s.goal
            ? open(() => box.openContent(s.id, s.id, s.goal), `goal of sprint ${s.id}`)
            : { text: '', ok: true };
        const out = {
            id: s.id,
            name: name.text,
            goal: goal.text,
            status: s.status,
            startDate: s.startDate,
            endDate: s.endDate,
            capacityPoints: s.capacityPoints,
            sortOrder: s.sortOrder,
            itemCount: s.itemCount,
            pointsTotal: s.pointsTotal,
            pointsDone: s.pointsDone,
            doneCount: s.doneCount,
            createdBy: s.createdBy,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
        };
        if (!name.ok || !goal.ok) out.unreadable = true;
        return out;
    }

    /** A range a caller sends must hold on its own; a patch must hold against the endpoint it does not change. */
    function checkDates(start, end) {
        if (start && end && start > end) throw badRequest('invalid_date_range', 'The start date must be on or before the end date.');
    }

    router.get('/:id/sprints', requireRole('viewer'), async (req, res) => {
        const project = await loadProject(req);
        const box = await chatCrypto().forProject(project, { what: 'Sprints' });
        const sprints = await store().listSprints(project.id);
        res.json({ sprints: sprints.map((s) => presentSprint(box, s)) });
    });

    router.post('/:id/sprints', requireRole('editor'), validate({ body: S.CreateSprintBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const box = await chatCrypto().forProject(project, { what: 'Sprints' });
        const input = req.body;
        checkDates(input.startDate, input.endDate);
        const id = newId();
        const sprint = await store().createSprint({
            id,
            projectId: project.id,
            name: box.sealTitle(id, input.name.trim()),
            goal: input.goal ? box.sealContent(id, id, input.goal) : '',
            startDate: input.startDate || null,
            endDate: input.endDate || null,
            capacityPoints: input.capacityPoints == null ? null : input.capacityPoints,
            createdBy: userId,
        });
        await audit(project.id, userId, 'sprint.created', sprint.id);
        await emit(project.id, sprintEvent('sprint.created', userId, sprint.id));
        res.status(201).json({ sprint: presentSprint(box, sprint) });
    });

    router.patch('/:id/sprints/:sprintId', requireRole('editor'), validate({ body: S.UpdateSprintBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const sprint = await loadSprint(project, req.params.sprintId);
        const box = await chatCrypto().forProject(project, { what: 'Sprints' });
        const { name, goal, startDate, endDate, capacityPoints } = req.body;
        checkDates(startDate === undefined ? sprint.startDate : startDate, endDate === undefined ? sprint.endDate : endDate);
        const patch = {};
        if (name !== undefined) patch.name = box.sealTitle(sprint.id, name.trim());
        if (goal !== undefined) patch.goal = goal ? box.sealContent(sprint.id, sprint.id, goal) : '';
        if (startDate !== undefined) patch.startDate = startDate;
        if (endDate !== undefined) patch.endDate = endDate;
        if (capacityPoints !== undefined) patch.capacityPoints = capacityPoints;
        const updated = await store().updateSprint(project.id, sprint.id, patch);
        if (!updated) throw notFound('sprint_not_found', 'This sprint does not exist in this project.');
        await emit(project.id, sprintEvent('sprint.updated', userId, sprint.id));
        res.json({ sprint: presentSprint(box, updated) });
    });

    router.delete('/:id/sprints/:sprintId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const sprint = await loadSprint(project, req.params.sprintId);
        await store().deleteSprint(project.id, sprint.id);
        await audit(project.id, userId, 'sprint.deleted', sprint.id);
        await emit(project.id, sprintEvent('sprint.deleted', userId, sprint.id));
        res.json({ ok: true });
    });

    // Every task must belong to the project before anything is assigned, so a refusal assigns nothing.
    router.post('/:id/sprints/:sprintId/items', requireRole('editor'), validate({ body: S.AssignItemsBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const sprint = await loadSprint(project, req.params.sprintId);
        if (sprint.status === 'closed') throw closedError();
        const taskIds = [...new Set(req.body.taskIds)];
        for (const taskId of taskIds) {
            if (!(await taskStore().getTask(project.id, taskId))) {
                throw notFound('task_not_found', 'Every task must exist in this project.');
            }
        }
        const assigned = await store().assignTasks(project.id, sprint.id, taskIds);
        // Closed between the look-up and the write: nothing was assigned.
        if (assigned.length === 0) throw closedError();
        await emit(project.id, sprintEvent('sprint.updated', userId, sprint.id, { taskIds: assigned }));
        const box = await chatCrypto().forProject(project, { what: 'Sprints' });
        res.json({ sprint: presentSprint(box, await store().getSprint(project.id, sprint.id)) });
    });

    router.delete('/:id/sprints/:sprintId/items/:taskId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const sprint = await loadSprint(project, req.params.sprintId);
        if (!(await store().unassignTask(project.id, sprint.id, req.params.taskId))) {
            throw notFound('task_not_in_sprint', 'This task is not in this sprint.');
        }
        await emit(project.id, sprintEvent('sprint.updated', userId, sprint.id, { taskIds: [req.params.taskId] }));
        res.json({ ok: true });
    });

    router.post('/:id/sprints/:sprintId/start', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const sprint = await loadSprint(project, req.params.sprintId);
        if (sprint.status === 'closed') throw closedError();
        const started = await store().startSprint(project.id, sprint.id);
        if (!started) throw closedError();
        await emit(project.id, sprintEvent('sprint.updated', userId, sprint.id));
        const box = await chatCrypto().forProject(project, { what: 'Sprints' });
        res.json({ sprint: presentSprint(box, started) });
    });

    router.post('/:id/sprints/:sprintId/complete', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const sprint = await loadSprint(project, req.params.sprintId);
        if (sprint.status === 'closed') throw closedError();
        if (sprint.status !== 'active') throw notActiveError();
        const closed = await store().completeSprint(project.id, sprint.id);
        if (!closed) throw notActiveError();
        await emit(project.id, sprintEvent('sprint.updated', userId, sprint.id));
        const box = await chatCrypto().forProject(project, { what: 'Sprints' });
        res.json({ sprint: presentSprint(box, closed) });
    });

    // The database also checks the range when two editors change different endpoints.
    router.use((err, req, res, next) => {
        if (err.code === '23514' && err.constraint === 'project_sprints_date_range') return next(badRequest('invalid_date_range', 'The start date must be on or before the end date.'));
        // Two sprints started at the same moment: the index lets one win.
        if (err.code === '23505' && err.constraint === 'uq_project_sprints_one_active') return next(conflict('sprint_start_conflict', 'Another sprint was started at the same moment. Reload and try again.'));
        return next(err);
    });
    return router;
}

const router = makeProjectSprintsRouter();

module.exports = router;
module.exports.makeProjectSprintsRouter = makeProjectSprintsRouter;

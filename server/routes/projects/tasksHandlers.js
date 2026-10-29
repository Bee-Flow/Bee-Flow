// @typecheck
/**
 * Project tasks: the handler bodies of the task routes (board, create,
 * batch, meeting suggestions, the AI improvements, update, delete). The
 * route table stays in tasks.js; each handler takes the shared context
 * (./tasksContext.js) first. Split out of tasks.js; behaviour unchanged.
 */

'use strict';

const log = require('../../telemetry/log');
const { badRequest, forbidden, notFound, conflict } = require('../../core/http/errors');
const { itemTextHash, itemKey, createdTaskFor } = require('../../projects/taskFromMeeting');
const { taskEvent, presentTask, sealList, checkDates } = require('./tasksPresent');
const {
    checkedAssignees, checkedLinks, checkedHierarchy, prepareTask, announceAssigned, announceCreated, meetingTexts, alreadyATask,
} = require('./tasksRules');

async function board(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const project = await ctx.loadProject(req);
    const box = await ctx.boxFor(project);
    const { tasks, truncated } = await ctx.store().listBoard(project.id);
    res.json({ tasks: tasks.map((t) => presentTask(box, t)), truncated, role: req.projectRole });
}

async function createTask(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const box = await ctx.boxFor(project);
    const input = { ...req.body };
    if (input.source) {
        const textHash = itemTextHash((await meetingTexts(ctx, req, project)(input.source.id)).get(input.source.itemId));
        if (textHash) input.source = { ...input.source, textHash };
    }
    const { row, assigneeIds } = await prepareTask(ctx, project, box, userId, input);
    const task = await ctx.store().createTask(row);
    if (!task) throw alreadyATask();
    await announceCreated(ctx, project, userId, task, assigneeIds);
    res.status(201).json({ task: presentTask(box, task) });
}

// Everything is checked before anything is stored, so a refusal leaves no half a list. A task whose
// `source` already became a task here is skipped: the same meeting item is never made twice (the
// unique index on the source settles two requests that race; the one that loses skips it).
async function createBatch(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const box = await ctx.boxFor(project);
    const made = new Map();
    const textsOf = meetingTexts(ctx, req, project);
    const prepared = [];
    let skipped = 0;
    for (const item of req.body.items) {
        let input = item;
        if (input.source) {
            const { id: meetingId, itemId } = input.source;
            if (!made.has(meetingId)) made.set(meetingId, await ctx.store().tasksFromMeeting(project.id, meetingId));
            const text = (await textsOf(meetingId)).get(itemId);
            if (createdTaskFor(made.get(meetingId), itemId, text)) { skipped += 1; continue; }
            made.get(meetingId).set(itemKey(itemId, text), 'pending');
            const textHash = itemTextHash(text);
            if (textHash) input = { ...input, source: { ...input.source, textHash } };
        }
        const links = [...(input.links || [])];
        if (input.source && !links.some((l) => l.kind === 'meeting' && l.id === input.source.id)) links.push({ kind: 'meeting', id: input.source.id });
        prepared.push(await prepareTask(ctx, project, box, userId, { ...input, links }));
    }
    const tasks = [];
    for (const { row, assigneeIds } of prepared) {
        const task = await ctx.store().createTask(row);
        if (!task) { skipped += 1; continue; }
        await announceCreated(ctx, project, userId, task, assigneeIds);
        tasks.push(presentTask(box, task));
    }
    res.status(201).json({ tasks, skipped });
}

/** The meeting note when it is filed in this project, else a 404. */
async function filedMeeting(ctx, /** @type {import('express').Request} */ req, project) {
    if (!(await ctx.filedIds(project.id, 'meeting', [req.params.meetingId])).has(req.params.meetingId)) {
        throw notFound('meeting_not_found', 'This meeting is not filed in this project.');
    }
    const note = await ctx.readMeeting(req, project, req.params.meetingId);
    if (!note) throw notFound('meeting_not_found', 'This meeting is not filed in this project.');
    return note;
}

async function meetingSuggestions(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const project = await ctx.loadProject(req);
    const note = await filedMeeting(ctx, req, project);
    const { suggestionsFromNote } = require('../../projects/taskFromMeeting');
    const created = await ctx.store().tasksFromMeeting(project.id, note.id);
    res.json({
        meeting: { id: note.id, title: note.title || '' },
        suggestions: suggestionsFromNote(note, await ctx.listPeople(project), created),
    });
}

// The AI reads the notes as the asker and only suggests: nothing is made here.
async function improveMeetingSuggestions(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const project = await ctx.loadProject(req);
    const note = await filedMeeting(ctx, req, project);
    // Items that already became a task are expanded too: the person can let the AI improve the task that exists.
    const created = await ctx.store().tasksFromMeeting(project.id, note.id);
    const items = (Array.isArray(note.actionItems) ? note.actionItems : [])
        .filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string' && i.text.trim());
    const orgs = await ctx.resolveOrgs(req);
    const improved = await ctx.assistant().forMeeting({ project, userId: ctx.userIdOf(req), ...orgs, note, items, people: await ctx.listPeople(project) });
    const textOf = new Map(items.map((i) => [i.id, i.text]));
    res.json({ items: improved.map((i) => ({ ...i, createdTaskId: createdTaskFor(created, i.itemId, textOf.get(i.itemId)) })) });
}

async function improveTask(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const project = await ctx.loadProject(req);
    const task = await ctx.loadTask(project, req.params.taskId);
    const box = await ctx.boxFor(project);
    const shown = presentTask(box, task);
    if (shown.unreadable) throw conflict('task_unreadable', 'This task could not be read, so it cannot be improved.');
    const orgs = await ctx.resolveOrgs(req);
    const suggestion = await ctx.assistant().forTask({ project, userId: ctx.userIdOf(req), ...orgs, task: shown, people: await ctx.listPeople(project) });
    res.json({ suggestion });
}

/** The sealed patch for the plain fields of an update (no people, links or move). */
function fieldPatch(box, task, body, itemType, parentTaskId) {
    const { title, description, startDate, dueDate, priority } = body;
    const patch = {};
    if (title !== undefined) patch.title = box.sealTitle(task.id, title.trim());
    if (description !== undefined) patch.description = box.sealContent(task.id, task.id, description);
    if (priority !== undefined) patch.priority = priority;
    if (body.itemType !== undefined) patch.itemType = itemType;
    if (body.parentTaskId !== undefined) patch.parentTaskId = parentTaskId;
    if (body.storyPoints !== undefined) patch.storyPoints = body.storyPoints;
    if (startDate !== undefined) patch.startDate = startDate;
    if (dueDate !== undefined) patch.dueDate = dueDate;
    if (body.labels !== undefined) patch.labels = body.labels.length ? sealList(box, task.id, 'labels', [...new Set(body.labels)]) : '';
    if (body.checklist !== undefined) patch.checklist = body.checklist.length ? sealList(box, task.id, 'checklist', body.checklist) : '';
    return patch;
}

async function updateTask(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const task = await ctx.loadTask(project, req.params.taskId);
    const box = await ctx.boxFor(project);
    const { status, startDate, dueDate, beforeId } = req.body;
    const itemType = req.body.itemType === undefined ? (task.itemType || 'task') : req.body.itemType;
    const parentTaskId = req.body.parentTaskId === undefined ? task.parentTaskId || null : req.body.parentTaskId;
    checkDates(startDate === undefined ? task.startDate : startDate, dueDate === undefined ? task.dueDate : dueDate);
    await checkedHierarchy(ctx, project.id, task.id, itemType, parentTaskId);
    const patch = fieldPatch(box, task, req.body, itemType, parentTaskId);
    // A move names the column and where in it; a plain status change goes to the end of its column.
    const moves = beforeId !== undefined;
    if (status !== undefined && !moves) patch.status = status;
    let added = [];
    if (req.body.assigneeIds !== undefined) {
        patch.assigneeIds = await checkedAssignees(ctx, project.id, req.body.assigneeIds);
        added = patch.assigneeIds.filter((id) => !task.assigneeIds.includes(id));
    }
    if (req.body.links !== undefined) patch.links = await checkedLinks(ctx, project.id, req.body.links, task.links, task.id);
    // The neighbour is looked up before anything is written, so a move that cannot happen changes nothing.
    const moveError = () => badRequest('move_target_not_found', 'beforeId must be a task in the column the task moves to.');
    if (moves && beforeId) {
        const neighbour = await ctx.store().getTask(project.id, beforeId);
        if (!neighbour || neighbour.status !== (status || task.status)) throw moveError();
    }
    let updated = await ctx.store().updateTask(project.id, task.id, patch);
    if (moves && updated) {
        updated = await ctx.store().moveTask(project.id, task.id, { status: status || task.status, beforeId });
        if (!updated) {
            // The neighbour went between the look-up and the move: the other fields are saved, so say so.
            await ctx.emit(project.id, taskEvent('task.updated', userId, task.id));
            throw moveError();
        }
    }
    if (!updated) throw notFound('task_not_found', 'This task does not exist in this project.');
    await ctx.emit(project.id, taskEvent('task.updated', userId, task.id));
    if (added.length) await announceAssigned(ctx, project, userId, task.id, added);
    res.json({ task: presentTask(box, updated) });
}

async function deleteTask(ctx, /** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const task = await ctx.loadTask(project, req.params.taskId);
    if (task.createdBy !== userId && req.projectRole !== 'owner') {
        throw forbidden('not_task_author', 'Only the person who made this task, or the project owner, can delete it.');
    }
    await ctx.store().deleteTask(project.id, task.id);
    try {
        await ctx.store().dropLinksTo(project.id, 'task', task.id);
    } catch (err) {
        log.warn(`[ProjectTasks] links to deleted task ${task.id} not removed: ${err && /** @type {Error} */ (err).message}`);
    }
    try {
        await ctx.commentStore().deleteForTarget('task', task.id);
    } catch (err) {
        log.warn(`[ProjectTasks] comment threads of task ${task.id} not removed: ${err && /** @type {Error} */ (err).message}`);
    }
    await ctx.audit(project.id, userId, 'task.deleted', task.id);
    await ctx.emit(project.id, taskEvent('task.deleted', userId, task.id));
    res.json({ ok: true });
}

module.exports = {
    board, createTask, createBatch, meetingSuggestions, improveMeetingSuggestions, improveTask, updateTask, deleteTask,
};

// @typecheck
/**
 * Project tasks: what a task may hold (assignees on the project, links into
 * the project, a hierarchy without loops), the shaping of a new task's sealed
 * row, the announcements after one is made or given to someone, and the
 * meeting texts that pin a task to its action item. Each takes the shared
 * context (./tasksContext.js) first. Split out of tasks.js; behaviour
 * unchanged.
 */

'use strict';

const { badRequest, conflict } = require('../../core/http/errors');
const { taskEvent, sealList, checkDates, canContain } = require('./tasksPresent');
const { fallback } = require('../../utils/bestEffort');

/** Assignees must be on the project right now. */
async function checkedAssignees(ctx, projectId, ids) {
    const unique = [...new Set(ids || [])];
    for (const id of unique) {
        let role = null;
        try { role = await ctx.getProjectRole(id, projectId); } catch (err) { fallback('routes/projects/tasksRules:checkedAssignees', err); /* unknown is not a member */ }
        if (!role) throw badRequest('assignee_not_member', 'You can only give a task to a member of this project.');
    }
    return unique;
}

const NOT_IN_PROJECT = 'You can only link documents, notebooks, meetings, chats and threads of this project.';

/** A dependency points from this task to a predecessor; reject cycles. */
async function rejectDependencyCycles(ctx, projectId, kept, taskId) {
    for (const link of kept.filter(l => l.kind === 'task' && l.relation === 'depends_on')) {
        const seen = new Set();
        const pending = [link.id];
        while (pending.length) {
            const id = pending.pop();
            if (id === taskId) throw badRequest('invalid_task_dependency', 'Task dependencies cannot form a cycle.');
            if (seen.has(id)) continue;
            seen.add(id);
            const predecessor = await ctx.store().getTask(projectId, id);
            for (const next of predecessor?.links || []) {
                if (next.kind === 'task' && next.relation === 'depends_on') pending.push(next.id);
            }
        }
    }
}

/**
 * Every link must point into this project. `stored` are the links the task already has: they are
 * kept as they are and not checked again, so one that has since gone stale never blocks editing the others.
 */
async function checkedLinks(ctx, projectId, links, stored = [], taskId = null) {
    /** @type {{ kind: string, id: string, chatId?: string, relation?: 'depends_on' }[]} */
    const kept = [];
    for (const l of links || []) {
        if (kept.some((k) => k.kind === l.kind && k.id === l.id)) continue;
        kept.push(l.kind === 'thread' ? { kind: 'thread', id: l.id, chatId: l.chatId } : { kind: l.kind, id: l.id, ...(l.kind === 'task' && l.relation === 'depends_on' ? { relation: l.relation } : {}) });
    }
    const sameLink = (a, b) => a.kind === b.kind && a.id === b.id && (a.kind !== 'thread' || a.chatId === b.chatId) && a.relation === b.relation;
    const added = kept.filter((l) => !stored.some((k) => sameLink(k, l)));
    for (const kind of ['document', 'notebook', 'meeting']) {
        const wanted = added.filter((l) => l.kind === kind);
        if (wanted.length === 0) continue;
        const filed = await ctx.filedIds(projectId, kind, wanted.map((l) => l.id));
        if (wanted.some((l) => !filed.has(l.id))) throw badRequest('link_not_in_project', NOT_IN_PROJECT);
    }
    for (const l of added) {
        if (l.kind === 'task') {
            if (l.id === taskId || !(await ctx.store().getTask(projectId, l.id))) throw badRequest('link_not_in_project', 'Choose another task in this project to link.');
        } else if (l.kind === 'chat') {
            if (!(await ctx.chatStore().getChat(projectId, l.id))) throw badRequest('link_not_in_project', NOT_IN_PROJECT);
        } else if (l.kind === 'thread') {
            const chat = await ctx.chatStore().getChat(projectId, l.chatId);
            const root = chat ? await ctx.chatStore().getMessage(chat.id, l.id) : null;
            if (!root || root.threadId || root.deletedAt) throw badRequest('link_not_in_project', NOT_IN_PROJECT);
        }
    }
    await rejectDependencyCycles(ctx, projectId, kept, taskId);
    return kept;
}

async function checkedHierarchy(ctx, projectId, taskId, itemType, parentTaskId) {
    if (itemType === 'epic' && parentTaskId) throw badRequest('invalid_task_parent', 'An epic cannot have a parent task.');
    if (parentTaskId) {
        if (parentTaskId === taskId) throw badRequest('invalid_task_parent', 'A task cannot be its own parent.');
        let parent = await ctx.store().getTask(projectId, parentTaskId);
        if (!parent) throw badRequest('invalid_task_parent', 'Choose a parent task in this project.');
        if (!canContain(parent.itemType || 'task', itemType)) throw badRequest('invalid_task_parent', 'Link stories and user stories to epics, and tasks to stories.');
        const seen = new Set([taskId]);
        while (parent) {
            if (seen.has(parent.id)) throw badRequest('invalid_task_parent', 'This parent would create a task hierarchy loop.');
            seen.add(parent.id);
            if (!parent.parentTaskId) break;
            parent = await ctx.store().getTask(projectId, parent.parentTaskId);
        }
    }
    if (taskId && itemType) {
        const children = (await ctx.store().listSearchTasks(projectId)).filter(task => task.parentTaskId === taskId);
        if (children.some(child => !canContain(itemType, child.itemType || 'task'))) {
            throw badRequest('invalid_task_parent', 'Remove or move this task’s linked items before changing its type.');
        }
    }
}

/** Validate one task's people and links, and shape the row to store (sealed). Nothing is written. */
async function prepareTask(ctx, project, box, userId, input) {
    checkDates(input.startDate, input.dueDate);
    const itemType = input.itemType || 'task';
    await checkedHierarchy(ctx, project.id, null, itemType, input.parentTaskId || null);
    const assigneeIds = await checkedAssignees(ctx, project.id, input.assigneeIds);
    const links = await checkedLinks(ctx, project.id, input.links);
    const id = ctx.newId();
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
            itemType,
            parentTaskId: input.parentTaskId || null,
            storyPoints: input.storyPoints || null,
            assigneeIds,
            links,
            startDate: input.startDate || null,
            dueDate: input.dueDate || null,
            source: input.source || null,
            createdBy: userId,
        },
        assigneeIds,
    };
}

/** The live feed, and the bell of everyone newly given the task. */
async function announceAssigned(ctx, project, actorId, taskId, assigneeIds) {
    await ctx.emit(project.id, taskEvent('task.assigned', actorId, taskId, { assigneeIds }));
    await ctx.notifier().assigned({ project, actorId, assigneeIds, taskId });
}

async function announceCreated(ctx, project, userId, task, assigneeIds) {
    await ctx.audit(project.id, userId, 'task.created', task.id);
    await ctx.emit(project.id, taskEvent('task.created', userId, task.id));
    if (assigneeIds.length) await announceAssigned(ctx, project, userId, task.id, assigneeIds);
}

/**
 * What each action item of a meeting said, `itemId → text`, read once per meeting. The text is what pins a
 * task's `source` to its item: ids are positions and shift when the summary is regenerated. A meeting that
 * cannot be read gives no texts, and its tasks are keyed by id alone.
 */
function meetingTexts(ctx, /** @type {import('express').Request} */ req, project) {
    const seen = new Map();
    return async (meetingId) => {
        if (!seen.has(meetingId)) {
            const note = await ctx.readMeeting(req, project, meetingId);
            const items = note && Array.isArray(note.actionItems) ? note.actionItems : [];
            seen.set(meetingId, new Map(items.filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string').map((i) => [i.id, i.text])));
        }
        return seen.get(meetingId);
    };
}

const alreadyATask = () => conflict('already_a_task', 'This meeting item is already a task in this project.');

module.exports = {
    checkedAssignees, checkedLinks, checkedHierarchy, prepareTask, announceAssigned, announceCreated, meetingTexts, alreadyATask,
};

/** @typedef {ReturnType<typeof import('./tasksContext').makeTasksContext>} TasksCtx */

/** @typedef {Awaited<ReturnType<TasksCtx['boxFor']>>} TaskBox */

/** @typedef {Awaited<ReturnType<TasksCtx['loadProject']>>} TaskProject */

/** @typedef {{ kind: string, id: string, chatId?: string, relation?: 'depends_on' }} TaskLink */

/** @typedef {NonNullable<ReturnType<typeof import('../../stores/projectTaskStore').rowToTask>>} TaskRow */

/** @typedef {{ id: string, text: string }} ActionItem */

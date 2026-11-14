// @typecheck
/**
 * Project tasks: the pure pieces of routes/projects/tasks.js. How a sealed
 * task is opened and presented (an unreadable one flagged, not failed), how
 * lists are sealed, the feed event shape, the date-range rule and which item
 * types may contain which. Split out of tasks.js; behaviour unchanged.
 */

'use strict';

const log = require('../../telemetry/log');
const { badRequest } = require('../../core/http/errors');

const taskEvent = (kind, actorId, taskId, payload = {}) => ({
    kind, actorId, targetType: 'project_task', targetId: taskId, payload: { taskId, ...payload },
});

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
    const legacyType = labels.ok && labels.text.find(label => label.startsWith('bf:type:'))?.slice(8);
    const legacyPoints = labels.ok ? Number(labels.text.find(label => label.startsWith('bf:points:'))?.slice(10)) : NaN;
    const itemType = t.itemType === 'task' && ['epic', 'story', 'user-story'].includes(legacyType) ? legacyType : (t.itemType || 'task');
    /** @type {Record<string, any>} */
    const out = {
        id: t.id,
        title: title.text,
        description: description.text,
        status: t.status,
        priority: t.priority,
        itemType,
        parentTaskId: t.parentTaskId || null,
        storyPoints: t.storyPoints || ([1, 2, 3, 5, 8, 13, 21].includes(legacyPoints) ? legacyPoints : null),
        labels: labels.ok ? labels.text : [],
        checklist: checklist.ok ? checklist.text : [],
        sortOrder: t.sortOrder,
        source: t.source,
        assigneeIds: t.assigneeIds,
        links: t.links,
        startDate: t.startDate || null,
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

function checkDates(start, end) {
    if (start && end && start > end) throw badRequest('invalid_date_range', 'The start date must be on or before the due date.');
}

/**
 * @param {string} parentType
 * @param {string} childType
 */
const canContain = (parentType, childType) => parentType === 'epic'
    ? ['story', 'user-story'].includes(childType)
    : ['story', 'user-story'].includes(parentType) && ['user-story', 'task'].includes(childType);

module.exports = { taskEvent, presentTask, sealList, checkDates, canContain };

// @typecheck strict
/**
 * The bell notifications of project tasks: "a task was given to you" and, from
 * jobs/projectTaskDueNotifier.js, "a task is due". A notification names the
 * project and points at the task; it never carries what the task says (the
 * title and description are sealed with the project key, and the bell is a
 * plain table).
 */

'use strict';

const log = require('../telemetry/log');

/**
 * Every dependency is a test seam whose default is the real module.
 * `collabNotifier` is the collaboration notifier that rings and mails an
 * assignment (default: projects/collabNotify); `renderText` renders
 * `{ title, message }` in the recipient's locale (projects/collabNotify).
 *
 * @param {{
 *   createNotification?: (n: Parameters<typeof import('../stores/notificationStore').createNotification>[0]) => Promise<unknown>,
 *   projectPath?: (projectId: string, section?: string|null) => string,
 *   collabNotifier?: Pick<ReturnType<typeof import('./collabNotify').makeCollabNotifier>, 'taskAssigned'>,
 *   renderText?: ReturnType<typeof import('./collabNotify').makeRenderText> }} [deps]
 */
function makeTaskNotifier(deps = {}) {
    const createNotification = deps.createNotification || ((/** @type {Parameters<typeof import('../stores/notificationStore').createNotification>[0]} */ n) => require('../stores/notificationStore').createNotification(n));
    const projectPath = deps.projectPath || ((/** @type {string} */ id, /** @type {string|null} */ section) => require('../utils/appPaths').projectPath(id, section));
    const collabNotifier = deps.collabNotifier;
    const collab = () => collabNotifier || require('./collabNotify').makeCollabNotifier();
    const renderText = deps.renderText || ((/** @type {Parameters<ReturnType<typeof import('./collabNotify').makeRenderText>>[0]} */ p) => require('./collabNotify').makeRenderText()(p));

    /**
     * Best-effort: a bell that does not ring never undoes the task.
     * @param {string} userId
     * @param {{ key: string, category: string, project: { id: string, name: string }, taskId: string }} p
     */
    async function send(userId, { key, category, project, taskId }) {
        try {
            const { title, message } = await renderText({ userId, key, vars: { project: project.name } });
            await createNotification({ userId, category, title, message, link: projectPath(project.id, `tasks/${taskId}`) });
            return true;
        } catch (err) {
            log.warn(`[ProjectTasks] notification to ${userId} not created: ${err && /** @type {Error} */ (err).message}`);
            return false;
        }
    }

    /**
     * Tell the people newly given a task, except the one who gave it: bell and e-mail through the collaboration notifier (prefs and mutes apply).
     * @param {{ project: { id: string, name: string }, actorId: string, assigneeIds: string[], taskId: string }} p
     */
    async function assigned({ project, actorId, assigneeIds, taskId }) {
        const others = [...new Set(assigneeIds || [])].filter((id) => id && id !== actorId);
        if (!others.length) return 0;
        return collab().taskAssigned({ project, actorId, assigneeIds: others, taskId });
    }

    /**
     * Tell the people mentioned in a comment on a task, except the one who wrote it.
     * @param {{ project: { id: string, name: string }, actorId: string, mentionedUserIds: string[], taskId: string }} p
     */
    async function mentioned({ project, actorId, mentionedUserIds, taskId }) {
        for (const userId of [...new Set(mentionedUserIds || [])].filter((id) => id && id !== actorId)) {
            await send(userId, {
                category: 'heads_up',
                key: 'project_collab.bell.task_mention',
                project,
                taskId,
            });
        }
    }

    /** @param {{ project: { id: string, name: string }, userId: string, taskId: string, tier: string }} p  tier is due_1d, due_today or overdue */
    async function due({ project, userId, taskId, tier }) {
        if (!['due_1d', 'due_today', 'overdue'].includes(tier)) return false;
        return send(userId, {
            category: tier === 'overdue' ? 'urgent' : 'heads_up',
            key: `project_collab.bell.task_${tier}`,
            project,
            taskId,
        });
    }

    return { assigned, mentioned, due };
}

module.exports = { makeTaskNotifier };

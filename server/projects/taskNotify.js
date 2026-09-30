// @typecheck
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
 * @param {object} [deps]
 * @param {Function} [deps.createNotification]  ({ userId, category, title, message, link }) => notification
 * @param {Function} [deps.projectPath]         (projectId, section) => in-app path
 */
function makeTaskNotifier(deps = {}) {
    const createNotification = deps.createNotification || ((n) => require('../stores/notificationStore').createNotification(n));
    const projectPath = deps.projectPath || ((id, section) => require('../utils/appPaths').projectPath(id, section));

    /** Best-effort: a bell that does not ring never undoes the task. */
    async function send(userId, { title, message, category, projectId, taskId }) {
        try {
            await createNotification({ userId, category, title, message, link: projectPath(projectId, `tasks/${taskId}`) });
            return true;
        } catch (err) {
            log.warn(`[ProjectTasks] notification to ${userId} not created: ${err && err.message}`);
            return false;
        }
    }

    /** Tell the people newly given a task, except the one who gave it. */
    async function assigned({ project, actorId, assigneeIds, taskId }) {
        const others = [...new Set(assigneeIds || [])].filter((id) => id && id !== actorId);
        for (const userId of others) {
            await send(userId, {
                category: 'heads_up',
                title: 'A task was given to you',
                message: `In the project "${project.name}".`,
                projectId: project.id,
                taskId,
            });
        }
        return others.length;
    }

    /** Tell the people mentioned in a comment on a task, except the one who wrote it. */
    async function mentioned({ project, actorId, mentionedUserIds, taskId }) {
        for (const userId of [...new Set(mentionedUserIds || [])].filter((id) => id && id !== actorId)) {
            await send(userId, {
                category: 'heads_up',
                title: 'You were mentioned on a task',
                message: `In the project "${project.name}".`,
                projectId: project.id,
                taskId,
            });
        }
    }

    /** @param {{ project: { id: string, name: string }, userId: string, taskId: string, tier: string }} p  tier is due_1d, due_today or overdue */
    async function due({ project, userId, taskId, tier }) {
        const text = { due_1d: 'A task is due tomorrow', due_today: 'A task is due today', overdue: 'A task is overdue' }[tier];
        if (!text) return false;
        return send(userId, {
            category: tier === 'overdue' ? 'urgent' : 'heads_up',
            title: text,
            message: `In the project "${project.name}".`,
            projectId: project.id,
            taskId,
        });
    }

    return { assigned, mentioned, due };
}

module.exports = { makeTaskNotifier };

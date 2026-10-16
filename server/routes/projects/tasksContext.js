// @typecheck
/**
 * Project tasks: the context every task handler shares. The injected
 * dependencies with their lazily required defaults (so requiring tasks.js
 * loads no store), plus the lookups and the audit trail built on them.
 * Split out of tasks.js; behaviour unchanged. The `deps` contract is
 * documented on makeProjectTasksRouter.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { projectAccessDeps } = require('./roleGate');
const { notFound, conflict } = require('../../core/http/errors');

/** The members that can be given a task: the owner and the people the project is shared with, in its org. */
async function listProjectPeople(project) {
    const { displayNameOf } = require('../../core/documents/documentPeople');
    const shares = await require('../../stores/projectStore').getProjectShares(project.id);
    const ids = [...new Set([project.ownerId, ...shares.filter((x) => x.sharedWithType === 'user').map((x) => x.sharedWithId)].filter(Boolean))];
    const { projectOrgOf, belongsToProjectOrg } = require('../../projects/projectOrg');
    const org = await projectOrgOf(project);
    const people = [];
    for (const id of ids) {
        try {
            const user = await require('../../stores/userStore').getUser(id);
            const name = user && await belongsToProjectOrg(id, org) ? displayNameOf(user) : '';
            if (name) people.push({ id, name });
        } catch (err) { log.warn(`[ProjectTasks] member lookup failed: ${err && err.message}`); }
    }
    return people;
}

/** The dependencies, each defaulting to the real module, required on first use. */
function resolveTasksDeps(deps) {
    const { requireRole, getProjectRole, getProject } = projectAccessDeps(deps);
    const userIdOf = (req) => req.session.user.id;
    // By id, never by listing: the stores page their project listings, and an item past the first page is still filed.
    const query = deps.query || ((sql, params) => require('../../db').pool.query(sql, params));
    let defaultAssistant = null;
    let defaultLimiter = null;
    return {
        requireRole, getProjectRole, getProject, userIdOf,
        store: () => deps.store || require('../../stores/projectTaskStore'),
        chatStore: () => deps.chatStore || require('../../stores/projectChatStore'),
        chatCrypto: () => deps.chatCrypto || require('../../projects/chatCrypto'),
        filedIds: deps.filedIds || (async (projectId, kind, ids) => {
            const lookup = require('../../projects/changeTitles').LOOKUPS[kind];
            if (!lookup || !ids.length) return new Set();
            const { rows } = await query(lookup, [projectId, [...new Set(ids)]]);
            return new Set(rows.map((r) => r.id));
        }),
        assistant: () => deps.assistant || (defaultAssistant || (defaultAssistant = require('../../projects/taskAssistant').makeTaskAssistant())),
        resolveOrgs: deps.resolveOrgs || (async (req) => {
            const userId = req.session.user.id;
            const orgId = await require('../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
            const limitOrgId = await require('../../core/entitlements/limits').resolveOrgId(req);
            return { orgId: orgId || null, limitOrgId: limitOrgId || null };
        }),
        improveLimiter: deps.improveLimiter || function rateLimitMiddleware(req, res, next) {
            if (!defaultLimiter) {
                defaultLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 20, name: 'project-task-ai' });
            }
            return defaultLimiter(req, res, next);
        },
        notifier: () => deps.notifier || require('../../projects/taskNotify').makeTaskNotifier(),
        commentStore: () => deps.commentStore || require('../../stores/projectCommentStore'),
        readMeeting: deps.readMeeting || (async (req, project, meetingId) => {
            const { resolveAccessContext } = require('../transcriptions/shared');
            const note = await require('../../stores/transcriptionStore').getTranscription(meetingId, userIdOf(req), await resolveAccessContext(req));
            return note && note.projectId === project.id ? note : null;
        }),
        listPeople: deps.listPeople || listProjectPeople,
        emit: deps.emit
            || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectTasks' })),
        publishTransient: () => deps.publishTransient || require('../../core/projectEventBus').publishTransient,
        logActivity: deps.logActivity
            || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details)),
        newId: deps.newId || (() => crypto.randomUUID()),
    };
}

/** The lookups and the audit trail on top of the dependencies; returns the full handler context. */
function makeTasksContext(deps = {}) {
    const ctx = resolveTasksDeps(deps);

    async function loadProject(req) {
        const project = await ctx.getProject(req.params.id);
        if (!project) throw notFound('not_found', 'Not found');
        if (project.kind === 'solution') {
            throw conflict('SOLUTION_HOLDS_NO_TASKS', 'A Studio Solution holds no tasks. Add the task to a project instead.');
        }
        return project;
    }

    async function loadTask(project, taskId) {
        const task = await ctx.store().getTask(project.id, taskId);
        if (!task) throw notFound('task_not_found', 'This task does not exist in this project.');
        return task;
    }

    async function audit(projectId, actorId, action, taskId) {
        try {
            await ctx.logActivity(projectId, actorId, action, { targetType: 'project_task', targetId: taskId });
        } catch (err) {
            log.warn(`[ProjectTasks] activity not recorded (${action}): ${err && err.message}`);
        }
    }

    /** The project key's box for tasks. */
    const boxFor = (project) => ctx.chatCrypto().forProject(project, { what: 'Tasks' });

    return Object.assign(ctx, { loadProject, loadTask, audit, boxFor });
}

module.exports = { makeTasksContext };

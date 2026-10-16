// @typecheck
/**
 * Tasks inside a project: to do, doing, done; given to members; with a
 * description and links to documents, notebooks, team chats and threads.
 * Mounted under /api/projects (the mount carries requireAuthedUser).
 *
 * GET    /:id/tasks             viewer   the project's board: every to-do and doing task, the most recently finished ones (`truncated` when older done tasks are left out)
 * POST   /:id/tasks             editor   make a task
 * PATCH  /:id/tasks/:taskId     editor   change any field (status, people, links, ...)
 * DELETE /:id/tasks/:taskId     editor   the one who made it, or the project owner
 * POST   /:id/tasks/batch       editor   make up to 50 tasks at once (from a meeting's action items)
 * POST   /:id/meetings/:meetingId/task-suggestions/improve   editor   the AI expands a meeting's action items (also the ones already made into tasks): description, priority, labels, checklist, and who, when plain
 * POST   /:id/tasks/:taskId/improve   editor   the AI's suggestion to improve one task (nothing is saved)
 * GET    /:id/meetings/:meetingId/task-suggestions   viewer   a meeting's action items as task suggestions
 *
 * Planning poker (one session per project): start names the task to estimate,
 * or a list of them — the first is voted on, the rest are queued behind it.
 * GET    /:id/tasks/poker/session         viewer   the running session, with the queue and its titles
 * POST   /:id/tasks/poker/session/start   editor   open a session on a task (`taskId`) or a queue (`taskIds`)
 * POST   /:id/tasks/poker/session/vote    viewer   cast a Fibonacci card
 * POST   /:id/tasks/poker/session/reveal  editor   show the cards
 * POST   /:id/tasks/poker/session/finish  editor   save the agreed estimate and close the session
 * POST   /:id/tasks/poker/session/next    editor   save the estimate and move to the next queued task (or close the session at the end of the queue)
 * POST   /:id/tasks/poker/session/cancel  editor   close the session without an estimate
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

const express = require('express');
const { validate } = require('../../core/http/validate');
const { badRequest, conflict } = require('../../core/http/errors');
const S = require('./taskSchemas');
const { makeTasksContext } = require('./tasksContext');
const T = require('./tasksHandlers');
const P = require('./tasksPoker');

/**
 * The route table. Handler bodies live in tasksHandlers.js (tasks) and
 * tasksPoker.js (planning poker), the validation and announcements in
 * tasksRules.js, the shared context in tasksContext.js and the presentation
 * in tasksPresent.js.
 *
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => Express middleware
 * @param {Function} [deps.getProjectRole]      (userId, projectId) => role|null
 * @param {Function} [deps.getProject]          (id) => project row
 * @param {any}   [deps.store]               stores/projectTaskStore surface
 * @param {any}   [deps.chatStore]           stores/projectChatStore surface, for chat and thread links
 * @param {any}   [deps.chatCrypto]          { forProject(project, { what }) }
 * @param {any}   [deps.assistant]          projects/taskAssistant surface: forMeeting, forTask
 * @param {Function} [deps.resolveOrgs]         (req) => { orgId, limitOrgId } for the asker's model tier and limits
 * @param {Function} [deps.improveLimiter]      Express middleware on the AI routes
 * @param {any}   [deps.notifier]           projects/taskNotify surface: assigned({project, actorId, assigneeIds, taskId}), the bell for a task given to someone
 * @param {any}   [deps.commentStore]       stores/projectCommentStore surface: deleteForTarget, so a deleted task takes its comment threads with it
 * @param {Function} [deps.readMeeting]         (req, project, meetingId) => the meeting note (with `actionItems`) when it is filed in this project, else null
 * @param {Function} [deps.listPeople]          (project) => [{ id, name }] the members that can be given a task
 * @param {Function} [deps.query]              (sql, params) => { rows }, what the default `filedIds` asks
 * @param {Function} [deps.filedIds]            (projectId, kind, ids) => Set of the `ids` of that kind filed in the project (may hold more)
 * @param {Function} [deps.emit]                (projectId, event) => durable event
 * @param {Function} [deps.publishTransient]    (projectId, event) => transient event (the live poker session)
 * @param {Function} [deps.logActivity]         (projectId, actorId, action, details)
 * @param {Function} [deps.newId]
 */
function makeProjectTasksRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const ctx = makeTasksContext(deps);
    const { requireRole, improveLimiter } = ctx;
    /** @param {(ctx: any, req: any, res: any) => any} handler */
    const h = (handler) => (req, res) => handler(ctx, req, res);

    router.get('/:id/tasks', requireRole('viewer'), h(T.board));

    // ── Planning poker ────────────────────────────────────────────────────
    router.get('/:id/tasks/poker/session', requireRole('viewer'), h(P.getSession));
    router.post('/:id/tasks/poker/session/start', requireRole('editor'), validate({ body: S.PokerStartBody }), h(P.startSession));
    router.post('/:id/tasks/poker/session/vote', requireRole('viewer'), validate({ body: S.PokerVoteBody }), h(P.vote));
    router.post('/:id/tasks/poker/session/reveal', requireRole('editor'), validate({ body: S.PokerSessionBody }), h(P.reveal));
    router.post('/:id/tasks/poker/session/finish', requireRole('editor'), validate({ body: S.PokerFinishBody }), h(P.finish));
    router.post('/:id/tasks/poker/session/cancel', requireRole('editor'), validate({ body: S.PokerSessionBody }), h(P.cancel));
    // Like finish, but for a queued session: the next queued task opens for voting.
    router.post('/:id/tasks/poker/session/next', requireRole('editor'), validate({ body: S.PokerFinishBody }), h(P.next));

    // ── Tasks ─────────────────────────────────────────────────────────────
    router.post('/:id/tasks', requireRole('editor'), validate({ body: S.CreateTaskBody }), h(T.createTask));
    router.post('/:id/tasks/batch', requireRole('editor'), validate({ body: S.BatchTasksBody }), h(T.createBatch));
    router.get('/:id/meetings/:meetingId/task-suggestions', requireRole('viewer'), h(T.meetingSuggestions));
    // The AI reads the notes as the asker and only suggests: nothing is made here.
    router.post('/:id/meetings/:meetingId/task-suggestions/improve', requireRole('editor'), improveLimiter, h(T.improveMeetingSuggestions));
    router.post('/:id/tasks/:taskId/improve', requireRole('editor'), improveLimiter, h(T.improveTask));
    router.patch('/:id/tasks/:taskId', requireRole('editor'), validate({ body: S.UpdateTaskBody }), h(T.updateTask));
    router.delete('/:id/tasks/:taskId', requireRole('editor'), h(T.deleteTask));

    // The database also checks ranges atomically when two editors change different endpoints.
    router.use((err, req, res, next) => {
        if (err.code === '23514' && err.constraint === 'project_tasks_date_range') return next(badRequest('invalid_date_range', 'The start date must be on or before the due date.'));
        // A queued poker task deleted mid-session cannot become the one being voted on.
        if (err.code === '23503' && err.constraint === 'project_task_poker_task_id_fkey') return next(conflict('poker_queue_task_gone', 'A task in the planning poker queue no longer exists. Cancel the session and start it again.'));
        return next(err);
    });
    return router;
}

const router = makeProjectTasksRouter();

module.exports = Object.assign(router, {
    makeProjectTasksRouter,
});

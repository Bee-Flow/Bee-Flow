// @typecheck
/**
 * Project tasks: planning poker (one session per project). The handler
 * bodies of the poker routes, and what a caller sees of a session (votes
 * only once revealed, the titles of the task and its queue). The route table
 * stays in tasks.js; each handler takes the shared context
 * (./tasksContext.js) first. Split out of tasks.js; behaviour unchanged.
 */

'use strict';

const { conflict } = require('../../core/http/errors');
const { taskEvent, presentTask } = require('./tasksPresent');

function pokerEvent(ctx, projectId, actorId, session) {
    const publish = ctx.publishTransient();
    return publish(projectId, { kind: 'task.poker.updated', actorId, targetType: 'project_task', targetId: session.taskId,
        payload: { sessionId: session.sessionId, taskId: session.taskId } });
}

function visiblePokerSession(session, userId) {
    if (!session || !['voting', 'revealed'].includes(session.phase)) return null;
    const votes = session.phase === 'revealed' ? session.votes : null;
    return { sessionId: session.sessionId, taskId: session.taskId, phase: session.phase,
        startedBy: session.startedBy, voterIds: Object.keys(session.votes || {}), ownVote: session.votes?.[userId] || null, votes,
        queueTaskIds: session.queue || [] };
}

/**
 * What the caller sees of a session plus the opened titles of the task being
 * estimated and of the queue behind it (null for one that went away). Null when
 * the session is closed or its task is gone.
 */
async function presentPokerSession(ctx, box, project, session, userId) {
    /** @type {Record<string, any> | null} */
    const out = visiblePokerSession(session, userId);
    if (!out) return null;
    const task = await ctx.store().getTask(project.id, session.taskId);
    if (!task) return null;
    out.taskTitle = presentTask(box, task).title;
    out.queueTitles = [];
    for (const id of session.queue || []) {
        const queued = await ctx.store().getTask(project.id, id);
        out.queueTitles.push(queued ? presentTask(box, queued).title : null);
    }
    return out;
}

async function getSession(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const session = await ctx.store().getPokerSession(project.id);
    const box = await ctx.boxFor(project);
    res.json({ session: await presentPokerSession(ctx, box, project, session, ctx.userIdOf(req)) });
}

async function startSession(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const ids = [...new Set(req.body.taskIds && req.body.taskIds.length ? req.body.taskIds : [req.body.taskId])];
    const tasks = [];
    for (const id of ids) tasks.push(await ctx.loadTask(project, id));
    const session = await ctx.store().startPokerSession(project.id, ctx.newId(), tasks[0].id, ctx.userIdOf(req), tasks.slice(1).map((t) => t.id));
    if (!session) throw conflict('poker_session_active', 'Another planning poker session is already active in this project.');
    await pokerEvent(ctx, project.id, ctx.userIdOf(req), session);
    const box = await ctx.boxFor(project);
    res.status(201).json({ session: await presentPokerSession(ctx, box, project, session, ctx.userIdOf(req)) });
}

async function vote(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const session = await ctx.store().castPokerVote(project.id, req.body.sessionId, ctx.userIdOf(req), req.body.vote);
    if (!session) throw conflict('poker_session_closed', 'This planning poker session is no longer accepting votes.');
    await pokerEvent(ctx, project.id, ctx.userIdOf(req), session);
    res.json({ session: visiblePokerSession(session, ctx.userIdOf(req)) });
}

async function reveal(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const session = await ctx.store().revealPokerVotes(project.id, req.body.sessionId);
    if (!session) throw conflict('poker_session_closed', 'This planning poker session is no longer accepting votes.');
    await pokerEvent(ctx, project.id, ctx.userIdOf(req), session);
    res.json({ session: visiblePokerSession(session, ctx.userIdOf(req)) });
}

async function finish(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const task = await ctx.store().finishPokerSession(project.id, req.body.sessionId, req.body.storyPoints);
    if (!task) throw conflict('poker_session_not_revealed', 'Reveal the votes before saving the agreed estimate.');
    const session = await ctx.store().getPokerSession(project.id);
    if (session) await pokerEvent(ctx, project.id, ctx.userIdOf(req), session);
    await ctx.emit(project.id, taskEvent('task.updated', ctx.userIdOf(req), task.id));
    const box = await ctx.boxFor(project);
    res.json({ task: presentTask(box, task) });
}

async function cancel(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const session = await ctx.store().cancelPokerSession(project.id, req.body.sessionId);
    if (!session) throw conflict('poker_session_closed', 'This planning poker session is already closed.');
    await pokerEvent(ctx, project.id, ctx.userIdOf(req), session);
    res.json({ ok: true });
}

// Like finish, but for a queued session: the agreed estimate lands on the current task and
// the next queued one opens for voting (the session completes at the end of the queue).
async function next(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const advanced = await ctx.store().advancePokerSession(project.id, req.body.sessionId, req.body.storyPoints);
    if (!advanced) throw conflict('poker_session_not_revealed', 'Reveal the votes before saving the agreed estimate.');
    await pokerEvent(ctx, project.id, ctx.userIdOf(req), advanced.session);
    await ctx.emit(project.id, taskEvent('task.updated', ctx.userIdOf(req), advanced.task.id));
    const box = await ctx.boxFor(project);
    res.json({ task: presentTask(box, advanced.task), session: await presentPokerSession(ctx, box, project, advanced.session, ctx.userIdOf(req)) });
}

module.exports = { getSession, startSession, vote, reveal, finish, cancel, next };

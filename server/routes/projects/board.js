'use strict';
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { projectAccessDeps } = require('./roleGate');
const { badRequest, conflict, notFound } = require('../../core/http/errors');
const STATUSES = ['todo', 'doing', 'done'];
const DEFAULT_COLUMNS = STATUSES.map(id => ({ id, title: '', status: id, wipLimit: null }));
const Column = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: z.string().trim().max(80), status: z.enum(STATUSES), wipLimit: z.number().int().min(1).max(100).nullable() }).strict();
const Config = z.object({ version: z.number().int().min(0), columns: z.array(Column).min(3).max(20) }).strict();
const Move = z.object({ columnId: z.string().max(80), beforeId: z.string().max(200).nullable().default(null) }).strict();
const Create = z.object({ columnId: z.string().max(80), title: z.string().trim().min(1).max(200) }).strict();
function columnFor(task, columns, assignments) {
    return columns.find(c => c.id === assignments[task.id] && c.status === task.status) || columns.find(c => c.status === task.status);
}
function makeBoardRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const { requireRole, getProject } = projectAccessDeps(deps);
    const boards = () => deps.boards || require('../../stores/projectBoardStore');
    const load = async req => {
        const project = await getProject(req.params.id);
        if (!project) throw notFound();
        if (project.kind === 'solution') throw conflict('SOLUTION_HOLDS_NO_TASKS', 'A Studio Solution holds no tasks.');
        const box = await (deps.crypto || require('../../projects/chatCrypto')).forProject(project);
        const seal = columns => box.sealContent('board', 'columns', JSON.stringify(columns));
        const decode = row => row ? JSON.parse(box.openContent('board', 'columns', row.columns_sealed)) : DEFAULT_COLUMNS;
        return { project, box, seal, decode };
    };
    const emit = async (id, kind, actorId, targetId = id) => {
        try { await (deps.emit || require('../../core/projectFeed').emitProjectEvent)(id, { kind, actorId, targetType: kind === 'task.board.updated' ? 'project' : 'project_task', targetId, payload: { taskId: targetId } }); } catch { /* query refetch recovers */ }
    };
    router.get('/:id/board', requireRole('viewer'), async (req, res) => {
        const { decode } = await load(req);
        const row = await boards().read(req.params.id);
        res.set('Cache-Control', 'no-store').json({ columns: decode(row), assignments: row?.assignments || {}, version: row?.version || 0 });
    });
    router.put('/:id/board', requireRole('editor'), validate({ body: Config }), async (req, res) => {
        const { columns, version } = req.body;
        if (new Set(columns.map(c => c.id)).size !== columns.length || STATUSES.some(s => !columns.some(c => c.status === s))) throw badRequest('invalid_columns', 'Keep at least one column for each status, with unique column IDs.');
        const { seal, decode } = await load(req);
        const result = await boards().change(req.params.id, seal(DEFAULT_COLUMNS), async (row, client) => {
            if (row.version !== version) throw conflict('board_changed', 'The board changed. Reload it before saving your columns.');
            const old = decode(row);
            const all = await (deps.taskStoreFor || require('../../stores/projectTaskStore').makeProjectTaskStore)(client).listSearchTasks(req.params.id);
            for (const task of all) {
                const from = columnFor(task, old, row.assignments);
                const to = columns.find(c => c.id === from?.id);
                if (!to || to.status !== task.status) throw conflict('column_not_empty', 'Move all tasks out of this column before removing it or changing its status.');
            }
            row.columns_sealed = seal(columns);
            return { columns, assignments: row.assignments };
        });
        await emit(req.params.id, 'task.board.updated', req.session.user.id);
        res.json(result);
    });
    router.post('/:id/board/tasks', requireRole('editor'), validate({ body: Create }), async (req, res) => {
        const { seal, decode, box } = await load(req);
        const id = crypto.randomUUID();
        const result = await boards().change(req.params.id, seal(DEFAULT_COLUMNS), async (row, client) => {
            const column = decode(row).find(c => c.id === req.body.columnId);
            if (!column) throw notFound();
            const store = (deps.taskStoreFor || require('../../stores/projectTaskStore').makeProjectTaskStore)(client);
            await store.createTask({ id, projectId: req.params.id, title: box.sealTitle(id, req.body.title), description: box.sealContent(id, id, ''), status: column.status, createdBy: req.session.user.id });
            row.assignments[id] = column.id;
            return { id };
        });
        try { await (deps.audit || require('../../stores/projectStore').logActivity)(req.params.id, req.session.user.id, 'task.created', { targetType: 'project_task', targetId: id }); } catch { /* activity must not turn a saved task into a failed create */ }
        await emit(req.params.id, 'task.created', req.session.user.id, id);
        res.status(201).json(result);
    });
    router.patch('/:id/board/tasks/:taskId', requireRole('editor'), validate({ body: Move }), async (req, res) => {
        const { seal, decode } = await load(req);
        const result = await boards().change(req.params.id, seal(DEFAULT_COLUMNS), async (row, client) => {
            const columns = decode(row);
            const column = columns.find(c => c.id === req.body.columnId);
            if (!column) throw notFound();
            const store = (deps.taskStoreFor || require('../../stores/projectTaskStore').makeProjectTaskStore)(client);
            const target = req.body.beforeId ? await store.getTask(req.params.id, req.body.beforeId) : null;
            if (req.body.beforeId && (!target || columnFor(target, columns, row.assignments)?.id !== column.id || target.id === req.params.taskId)) throw badRequest('invalid_position', 'The destination task is no longer in this column.');
            if (!(await store.moveTask(req.params.id, req.params.taskId, { status: column.status, beforeId: req.body.beforeId }))) throw notFound();
            row.assignments[req.params.taskId] = column.id;
            return { ok: true };
        });
        await emit(req.params.id, 'task.updated', req.session.user.id, req.params.taskId);
        res.json(result);
    });
    return router;
}
module.exports = makeBoardRouter();
module.exports.makeBoardRouter = makeBoardRouter;
module.exports.columnFor = columnFor;

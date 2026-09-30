'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { pgliteDb, createProjectScopedSchema } = require('../../testUtils/pgliteDb');
const { fakeRequireProjectRole } = require('../../testUtils/projectRoleGate');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { makeProjectBoardStore, DDL } = require('../../stores/projectBoardStore');
const { makeProjectTaskStore, DDL: TASK_DDL } = require('../../stores/projectTaskStore');
const { makeBoardRouter } = require('./board');
const { pg, db } = pgliteDb();
const boards = makeProjectBoardStore(db, db.tx);
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { user: { id: req.headers['x-user'] || 'editor' } }; next(); });
const box = { sealContent: (a,b,s) => Buffer.from(s).toString('base64'), openContent: (a,b,s) => Buffer.from(s,'base64').toString(), sealTitle: (id,s) => `encrypted:${s}` };
app.use('/api/projects', makeBoardRouter({ boards, crypto: { forProject: async () => box }, emit: async () => {}, audit: async () => {}, getProject: async id => ['p1','p2'].includes(id) ? { id } : null, requireProjectRole: fakeRequireProjectRole({ p1: { editor: 'editor', viewer: 'viewer' }, p2: { editor: 'editor' } }) }));
app.use(terminalErrorHandler);
let server;
before(async () => { await createProjectScopedSchema(pg, DDL + ';' + TASK_DDL); server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening',r)); });
after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await pg.close(); });
beforeEach(async () => { await pg.exec('DELETE FROM project_task_boards; DELETE FROM project_tasks'); });
async function call(path='', method='GET', body, user='editor', project='p1') {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project}/board${path}`, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
}
const custom = board => ({ version: board.version, columns: [...board.columns, { id:'review', title:'Review', status:'doing', wipLimit:2 }] });
test('board is readable by viewers but all writes require editor membership', async () => {
    assert.equal((await call('', 'GET', null, 'viewer')).status, 200);
    assert.equal((await call('', 'GET', null, 'stranger')).status, 404);
    for (const [path,method,body] of [['','PUT',custom((await call()).body)], ['/tasks','POST',{columnId:'todo',title:'Test'}], ['/tasks/x','PATCH',{columnId:'todo'}]]) assert.equal((await call(path,method,body,'viewer')).status,403);
});
test('custom columns persist encrypted, use versions and require a column for every status', async () => {
    const config = custom((await call()).body);
    assert.equal((await call('', 'PUT', config)).status,200);
    assert.equal((await call()).body.columns.at(-1).title,'Review');
    assert.equal((await boards.read('p1')).columns_sealed.includes('Review'),false);
    assert.equal((await call('', 'PUT', config)).status,409);
    assert.equal((await call('', 'PUT',{version:1,columns:config.columns.filter(c=>c.status!=='done')})).status,400);
    assert.equal((await call('', 'GET',null,'editor','p2')).body.columns.length,3);
});
test('quick add and moves atomically preserve column, position, semantic status and project scope', async () => {
    await call('', 'PUT', custom((await call()).body));
    const first=(await call('/tasks','POST',{columnId:'review',title:'Review proposal'})).body.id;
    const second=(await call('/tasks','POST',{columnId:'review',title:'Review design'})).body.id;
    const tasks=makeProjectTaskStore(db);
    assert.equal((await tasks.getTask('p1',first)).status,'doing');
    assert.equal((await call()).body.assignments[first],'review');
    assert.equal((await call(`/tasks/${second}`,'PATCH',{columnId:'review',beforeId:first})).status,200);
    assert.ok((await tasks.getTask('p1',second)).sortOrder < (await tasks.getTask('p1',first)).sortOrder);
    assert.equal((await call(`/tasks/${second}`,'PATCH',{columnId:'done',beforeId:first})).status,400);
    assert.equal((await call(`/tasks/${first}`,'PATCH',{columnId:'done'})).status,200);
    assert.ok((await tasks.getTask('p1',first)).completedAt);
    assert.equal((await call(`/tasks/${first}`,'PATCH',{columnId:'todo'},'editor','p2')).status,404);
    assert.equal((await tasks.getTask('p1',first)).status,'done');
    const config=(await call()).body;
    assert.equal((await call('', 'PUT',{version:config.version,columns:config.columns.filter(c=>c.id!=='review')})).status,409);
});
test('a rejected quick-add creates neither a task nor a board row', async()=>{
    assert.equal((await call('/tasks','POST',{columnId:'missing',title:'Draft'})).status,404);
    assert.equal(await boards.read('p1'),null);
    assert.equal((await makeProjectTaskStore(db).listTasks('p1')).length,0);
});

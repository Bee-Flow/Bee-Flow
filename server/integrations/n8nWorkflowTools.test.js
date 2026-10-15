'use strict';

/**
 * Characterisation of executeN8nWorkflowTool: every tool's argument checks,
 * request shape and answer, against a loopback n8n stand-in. configStore is
 * stubbed on the module object (read at call time); `../db` is stubbed through
 * require.cache so requiring configStore opens no pool (same as n8nTools.test).
 *
 * Run: cd server && node --test integrations/n8nWorkflowTools.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const dbPath = require.resolve('../db');
const noop = async () => {};
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
        run: async () => ({ rows: [], rowCount: 0 }),
        getOne: async () => null,
        getAll: async () => [],
        exec: noop,
        getClient: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
        withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
        makeStoreInit: () => noop,
        getPoolStats: () => ({}),
        getRedis: () => null,
        redisHealthy: () => false,
        disconnectRedis: noop,
    },
};

const configStore = require('../stores/configStore');
const { executeN8nWorkflowTool, N8N_WORKFLOW_TOOLS, isN8nWorkflowTool, getN8nToolPermission } = require('./n8nWorkflowTools');

let server;
let baseUrl;
/** "METHOD /path?query" -> { status, body } | (req) => { status, body }; consumed list entries in order. */
let routes = {};
let seen = [];

before(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const key = `${req.method} ${req.url}`;
            seen.push({ key, body: raw ? JSON.parse(raw) : undefined, apiKey: req.headers['x-n8n-api-key'] });
            let r = routes[key];
            if (Array.isArray(r)) r = r.shift();
            if (!r) r = { status: 599, body: `unscripted ${key}` };
            res.writeHead(r.status, { 'content-type': 'application/json' });
            res.end(r.status === 204 ? '' : JSON.stringify(r.body));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
    routes = {};
    seen = [];
    configStore.getConfig = async (k) => (k === 'n8n_url_org_o1' ? baseUrl : null);
    configStore.getSecret = async (k) => (k === 'n8n_api_key_org_o1' ? 'KEY' : null);
});

const call = (tool, args) => executeN8nWorkflowTool(tool, args, 'o1');
const ok = (body, status = 200) => ({ status, body });
const API = '/api/v1';

const WF = {
    id: 'w1', name: 'Flow', active: false, createdAt: 'c', updatedAt: 'u', tags: [{ name: 't1' }, 'raw'],
    settings: { executionOrder: 'v1' },
    nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: { a: 1 } },
        { name: 'Http', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [1, 0], disabled: true, credentials: { c: 1 } },
        { name: 'Note', type: 'n8n-nodes-base.stickyNote' },
    ],
    connections: { Start: { main: [[{ node: 'Http', type: 'main', index: 0 }]] } },
};
const SUMMARY = { id: 'w1', name: 'Flow', active: false, nodeCount: 2, nodeTypes: ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest'], tags: ['t1', 'raw'], createdAt: 'c', updatedAt: 'u' };

test('identification, permissions and the tool list agree', () => {
    for (const t of N8N_WORKFLOW_TOOLS) {
        assert.ok(isN8nWorkflowTool(t.function.name));
        assert.ok(['use_n8n_tools', 'modify_n8n_workflows'].includes(getN8nToolPermission(t.function.name)));
    }
    assert.equal(isN8nWorkflowTool('other'), false);
    assert.equal(getN8nToolPermission('unknown'), 'modify_n8n_workflows');
});

test('no organisation, unknown tool, unconfigured n8n', async () => {
    assert.deepEqual(await executeN8nWorkflowTool('n8n_workflow_list', {}, null), { error: 'No organization found. n8n workflow management requires an organization with n8n configured.' });
    assert.deepEqual(await call('n8n_workflow_nope', {}), { error: 'Unknown n8n workflow tool: n8n_workflow_nope' });
    assert.deepEqual(await call('constructor', {}), { error: 'Unknown n8n workflow tool: constructor' });
    assert.deepEqual(await executeN8nWorkflowTool('n8n_workflow_list', {}, 'other'), { error: 'n8n operation failed: n8n is not configured for this organization. Set the URL and API key in Organisation Settings.' });
});

test('an API failure becomes an error answer carrying the status', async () => {
    routes[`GET ${API}/workflows?limit=50`] = ok('boom', 500);
    assert.deepEqual(await call('n8n_workflow_list', {}), { error: 'n8n operation failed: n8n API error (500): "boom"' });
});

test('list: caps the limit, passes filters, sends the API key', async () => {
    routes[`GET ${API}/workflows?limit=250&active=true&tags=a%20b`] = ok({ data: [WF] });
    const out = await call('n8n_workflow_list', { limit: 9999, active: true, tags: 'a b' });
    assert.deepEqual(out, { total: 1, workflows: [SUMMARY] });
    assert.equal(seen[0].apiKey, 'KEY');
    routes[`GET ${API}/workflows?limit=50`] = ok({ data: 'weird' });
    assert.deepEqual(await call('n8n_workflow_list', {}), { total: 0, workflows: [] });
});

test('get: full result, required id, auto-summary over 200KB unless full', async () => {
    assert.deepEqual(await call('n8n_workflow_get', {}), { error: 'workflow_id is required' });
    routes[`GET ${API}/workflows/w1`] = ok(WF);
    const out = await call('n8n_workflow_get', { workflow_id: 'w1' });
    assert.equal(out.id, 'w1');
    assert.deepEqual(out.tags, ['t1', 'raw']);
    assert.deepEqual(out.nodes[1], { name: 'Http', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [1, 0], parameters: {}, disabled: true, credentials: { c: 1 } });
    assert.equal(out.nodes.length, 3);
    const big = { ...WF, nodes: [{ name: 'Big', type: 'x', parameters: { blob: 'z'.repeat(210000) } }] };
    routes[`GET ${API}/workflows/w1`] = ok(big);
    const sum = await call('n8n_workflow_get', { workflow_id: 'w1' });
    assert.match(sum._note, /^Full workflow JSON is \d+ chars\. Auto-summarised/);
    assert.deepEqual(sum.nodeDetails, [{ name: 'Big', type: 'x', disabled: false }]);
    routes[`GET ${API}/workflows/w1`] = ok(big);
    assert.equal((await call('n8n_workflow_get', { workflow_id: 'w1', full: true })).nodes[0].parameters.blob.length, 210000);
});

test('nodes_find: filters, dual-accepts stringified names, explains no match', async () => {
    assert.deepEqual(await call('n8n_workflow_nodes_find', {}), { error: 'workflow_id is required' });
    assert.deepEqual(await call('n8n_workflow_nodes_find', { workflow_id: 'w1' }), { error: 'At least one filter is required (node_type_pattern, node_names, or has_param).' });
    routes[`GET ${API}/workflows/w1`] = [ok(WF), ok(WF), ok(WF)];
    const byType = await call('n8n_workflow_nodes_find', { workflow_id: 'w1', node_type_pattern: 'HTTP' });
    assert.equal(byType.match_count, 1);
    assert.equal(byType.workflow_name, 'Flow');
    assert.equal(byType.matched_nodes[0].name, 'Http');
    assert.equal(byType._note, undefined);
    const byName = await call('n8n_workflow_nodes_find', { workflow_id: 'w1', node_names: '["Start"]' });
    assert.deepEqual(byName.matched_nodes.map(n => n.name), ['Start']);
    const none = await call('n8n_workflow_nodes_find', { workflow_id: 'w1', node_type_pattern: 'zzz' });
    assert.equal(none.match_count, 0);
    assert.match(none._note, /^No nodes matched/);
});

const NODES = [{ name: 'A', type: 't', parameters: {} }, { name: 'B', type: 't', parameters: {} }];
const CONNS = { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } };

test('create: validation, hygiene of the body, optional activation and its failure', async () => {
    assert.deepEqual(await call('n8n_workflow_create', {}), { error: 'name is required' });
    assert.deepEqual(await call('n8n_workflow_create', { name: 'N', nodes: 'x', connections: CONNS }), { error: 'n8n operation failed: Invalid JSON for "nodes": Unexpected token \'x\', "x" is not valid JSON' });
    assert.deepEqual(await call('n8n_workflow_create', { name: 'N', nodes: {}, connections: CONNS }), { error: 'nodes must be a JSON array of node objects' });
    assert.deepEqual(await call('n8n_workflow_create', { name: 'N', nodes: NODES, connections: [] }), { error: 'connections must be a JSON object' });
    routes[`POST ${API}/workflows`] = [ok({ id: 'w2', name: 'N', nodes: NODES, tags: [] }), ok({ id: 'w3', name: 'M', nodes: NODES })];
    const out = await call('n8n_workflow_create', { name: 'N', nodes: NODES, connections: CONNS, settings: { executionOrder: 'v1', evil: 1 }, active: false });
    assert.equal(out.success, true);
    assert.equal(out.message, 'Workflow "N" created.');
    assert.equal(out.id, 'w2');
    assert.deepEqual(seen[0].body, { name: 'N', nodes: NODES, connections: CONNS, settings: { executionOrder: 'v1' } });
    routes[`POST ${API}/workflows/w3/activate`] = ok({});
    const act = await call('n8n_workflow_create', { name: 'M', nodes: NODES, connections: CONNS, active: true });
    assert.equal(act.message, 'Workflow "M" created and activated.');
    assert.equal(act.active, true);
    routes[`POST ${API}/workflows`] = ok({ id: 'w4', name: 'K', nodes: [] });
    routes[`POST ${API}/workflows/w4/activate`] = ok('nope', 400);
    const bad = await call('n8n_workflow_create', { name: 'K', nodes: NODES, connections: CONNS, active: true });
    assert.equal(bad.success, true);
    assert.match(bad.message, /^Workflow "K" created but activation failed: n8n API error \(400\)/);
});

test('create refuses a connection to a missing node', async () => {
    const out = await call('n8n_workflow_create', { name: 'N', nodes: NODES, connections: { A: { main: [[{ node: 'GHOST', type: 'main', index: 0 }]] } } });
    assert.match(out.error, /^n8n operation failed: /);
    assert.match(out.error, /GHOST/);
    assert.equal(seen.length, 0);
});

test('update: validation and PUT body', async () => {
    assert.deepEqual(await call('n8n_workflow_update', {}), { error: 'workflow_id is required' });
    assert.deepEqual(await call('n8n_workflow_update', { workflow_id: 'w1' }), { error: 'name is required for full update' });
    assert.deepEqual(await call('n8n_workflow_update', { workflow_id: 'w1', name: 'N', nodes: {} }), { error: 'nodes must be a JSON array' });
    assert.deepEqual(await call('n8n_workflow_update', { workflow_id: 'w1', name: 'N', nodes: NODES, connections: null }), { error: 'connections must be a JSON object' });
    routes[`PUT ${API}/workflows/w1`] = ok({ id: 'w1', name: 'N', nodes: NODES });
    const out = await call('n8n_workflow_update', { workflow_id: 'w1', name: 'N', nodes: NODES, connections: CONNS, settings: { timezone: 'UTC', junk: 1 }, active: 1 });
    assert.equal(out.message, 'Workflow "N" fully updated.');
    assert.deepEqual(seen[0].body, { name: 'N', nodes: NODES, connections: CONNS, settings: { timezone: 'UTC' } });
});

test('patch: merges node operations, wholesale overrides and settings', async () => {
    assert.deepEqual(await call('n8n_workflow_patch', {}), { error: 'workflow_id is required' });
    routes[`GET ${API}/workflows/w1`] = [ok(WF), ok(WF), ok(WF), ok(WF), ok(WF)];
    routes[`PUT ${API}/workflows/w1`] = [ok({ id: 'w1', name: 'Renamed', nodes: [] }), ok({ id: 'w1', name: 'x', nodes: [] })];
    assert.deepEqual(await call('n8n_workflow_patch', { workflow_id: 'w1', node_operations: {} }), { error: 'node_operations must be a JSON array' });
    assert.deepEqual(await call('n8n_workflow_patch', { workflow_id: 'w1', nodes: {} }), { error: 'nodes must be a JSON array' });
    assert.deepEqual(await call('n8n_workflow_patch', { workflow_id: 'w1', connections: [] }), { error: 'connections must be a JSON object' });
    const out = await call('n8n_workflow_patch', { workflow_id: 'w1', name: 'Renamed', settings: { timezone: 'UTC' }, active: true });
    assert.equal(out.message, 'Workflow "Renamed" patched.');
    const put = seen.find(s => s.key.startsWith('PUT')).body;
    assert.equal(put.name, 'Renamed');
    assert.deepEqual(put.settings, { executionOrder: 'v1', timezone: 'UTC' });
    assert.equal(put.nodes.length, 3);
    assert.deepEqual(put.connections, WF.connections);
    assert.equal(put.active, undefined); // stripReadOnly drops it: activation is its own endpoint
    routes[`GET ${API}/workflows/w1`] = ok(WF);
    routes[`PUT ${API}/workflows/w1`] = ok({ id: 'w1', name: 'Flow', nodes: [] });
    seen = [];
    const ops = await call('n8n_workflow_patch', { workflow_id: 'w1', node_operations: [{ action: 'add', node_data: { name: 'New', type: 't' } }] });
    assert.equal(ops.success, true);
    assert.deepEqual(seen.find(s => s.key.startsWith('PUT')).body.nodes.map(n => n.name), ['Start', 'Http', 'Note', 'New']);
    routes[`GET ${API}/workflows/w1`] = ok(WF);
    assert.deepEqual(await call('n8n_workflow_patch', { workflow_id: 'w1', node_operations: [{ action: 'update', node_name: 'Nope', node_data: {} }] }), { error: 'n8n operation failed: node_operations: node "Nope" not found.' });
});

test('delete requires confirm:true', async () => {
    assert.deepEqual(await call('n8n_workflow_delete', {}), { error: 'workflow_id is required' });
    assert.deepEqual(await call('n8n_workflow_delete', { workflow_id: 'w1' }), { error: 'Delete requires confirm:true. Confirm with the user before calling this tool.' });
    assert.deepEqual(await call('n8n_workflow_delete', { workflow_id: 'w1', confirm: 'true' }), { error: 'Delete requires confirm:true. Confirm with the user before calling this tool.' });
    assert.equal(seen.length, 0);
    routes[`DELETE ${API}/workflows/w1`] = { status: 204 };
    assert.deepEqual(await call('n8n_workflow_delete', { workflow_id: 'w1', confirm: true }), { success: true, message: 'Workflow w1 deleted.' });
});

test('activate and deactivate', async () => {
    assert.deepEqual(await call('n8n_workflow_activate', {}), { error: 'workflow_id is required' });
    assert.deepEqual(await call('n8n_workflow_deactivate', {}), { error: 'workflow_id is required' });
    routes[`POST ${API}/workflows/w1/activate`] = ok({ id: 'w1', name: 'Flow' });
    assert.deepEqual(await call('n8n_workflow_activate', { workflow_id: 'w1' }), { success: true, message: 'Workflow "Flow" activated.', id: 'w1', name: 'Flow', active: true });
    routes[`POST ${API}/workflows/w1/deactivate`] = { status: 204 };
    assert.deepEqual(await call('n8n_workflow_deactivate', { workflow_id: 'w1' }), { success: true, message: 'Workflow "w1" deactivated.', id: 'w1', name: undefined, active: false });
});

test('execute: webhook-only diagnostic, missing execution id, finished run, timeout', async () => {
    assert.deepEqual(await call('n8n_workflow_execute', {}), { error: 'workflow_id is required' });
    const hook = { ...WF, nodes: [{ name: 'W', type: 'n8n-nodes-base.webhook' }] };
    routes[`GET ${API}/workflows/w1`] = [ok(hook), ok(WF), ok(WF), ok('x', 500), ok(WF)];
    const wh = await call('n8n_workflow_execute', { workflow_id: 'w1' });
    assert.match(wh.error, /^This workflow is webhook-triggered/);
    assert.equal(wh.workflow_id, 'w1');
    routes[`POST ${API}/workflows/w1/execute`] = [ok({}), ok({ data: { executionId: 77 } }), ok({ id: 5 }), ok({ id: 6 })];
    const none = await call('n8n_workflow_execute', { workflow_id: 'w1' });
    assert.deepEqual(none, { success: false, _note: 'n8n accepted the execute request but did not return an execution ID.', raw: {} });
    routes[`GET ${API}/executions/77?includeData=true`] = ok({ id: 77, finished: true, status: 'success', data: { resultData: { runData: {} } } });
    const done = await call('n8n_workflow_execute', { workflow_id: 'w1' });
    assert.equal(done.execution_id ?? done.id, 77);
    assert.equal(seen.filter(s => s.key.startsWith('POST') && s.key.endsWith('/execute'))[1].body && true, true);
    routes[`GET ${API}/executions/5?includeData=true`] = [ok({ id: 5, finished: false }), ok({ id: 5, finished: false })];
    const slow = await call('n8n_workflow_execute', { workflow_id: 'w1', timeout_seconds: 0 });
    assert.deepEqual(slow, { status: 'running', execution_id: 5, workflow_id: 'w1', _note: 'Timed out after 0s. Follow up with n8n_execution_get_detail using execution_id=5.' });
});

test('executions: list, get, detail, retry, stop', async () => {
    const EX = { id: 9, workflowId: 'w1', finished: true, mode: 'manual', startedAt: 's', stoppedAt: 'e', data: { resultData: { runData: {} } } };
    const SX = { id: 9, workflow_id: 'w1', status: 'success', mode: 'manual', started_at: 's', stopped_at: 'e', finished: true, retryOf: null };
    routes[`GET ${API}/executions?limit=100&workflowId=w%201&status=error`] = ok({ data: [EX] });
    assert.deepEqual(await call('n8n_execution_list', { workflow_id: 'w 1', status: 'error', limit: 5000 }), { total: 1, executions: [SX] });
    routes[`GET ${API}/executions?limit=20`] = ok([]);
    assert.deepEqual(await call('n8n_execution_list', {}), { total: 0, executions: [] });
    for (const t of ['n8n_execution_get', 'n8n_execution_get_detail', 'n8n_execution_retry', 'n8n_execution_stop']) {
        assert.deepEqual(await call(t, {}), { error: 'execution_id is required' });
    }
    routes[`GET ${API}/executions/9`] = ok(EX);
    assert.deepEqual(await call('n8n_execution_get', { execution_id: 9 }), SX);
    routes[`GET ${API}/executions/9?includeData=true`] = ok(EX);
    const detail = await call('n8n_execution_get_detail', { execution_id: 9 });
    assert.equal(detail.id ?? detail.execution_id, 9);
    routes[`POST ${API}/executions/9/retry`] = ok(EX);
    assert.deepEqual(await call('n8n_execution_retry', { execution_id: 9 }), { success: true, message: 'Retry started for execution 9.', ...SX });
    routes[`POST ${API}/executions/9/stop`] = ok(EX);
    assert.deepEqual(await call('n8n_execution_stop', { execution_id: 9 }), { success: true, message: 'Stop signal sent to execution 9.', ...SX });
});

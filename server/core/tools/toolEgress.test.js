/**
 * The dispatcher's egress chokepoint: every tool call leaves a ledger row,
 * exactly one, whoever dispatched it.
 *
 * A fake dispatch and a recording logger are injected; the probe API is the
 * real one, against a local server, so "which peers did the row get" is the
 * real capture's answer.
 *
 * Run: cd server && node --test core/tools/toolEgress.test.js
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createEgressChokepoint } = require('./toolEgress');
const probeApi = require('../http/outboundProbe');

let server;
let base;
const rows = [];
const log = (row) => { rows.push(row); };

before(async () => {
    server = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
beforeEach(() => { rows.length = 0; });

const fetchingTool = async () => (await fetch(`${base}/api`, { method: 'POST', body: 'x' })).text();

test('no probe active: the call runs in one, and one row carries its peers and the caller\'s ids', async () => {
    const executeTool = createEgressChokepoint(async (name, args) => ({ name, args, body: await fetchingTool() }), { logToolEgress: log });
    const out = await executeTool('fireflies_list_transcripts', { limit: 1 }, {
        userId: 'u1', orgId: 'org1', agentId: 'ag1', conversationId: 'c1',
        egress: { source: 'swarm', model: 'm1', ids: { agent_name: 'Researcher' } },
    });
    assert.deepStrictEqual(out, { name: 'fireflies_list_transcripts', args: { limit: 1 }, body: 'ok' }, 'the result is passed through untouched');
    assert.strictEqual(rows.length, 1);
    const [row] = rows;
    assert.strictEqual(row.toolName, 'fireflies_list_transcripts');
    assert.strictEqual(row.source, 'swarm');
    assert.strictEqual(row.model, 'm1');
    assert.strictEqual(row.error, null);
    assert.deepStrictEqual(row.result, out);
    assert.strictEqual(row.ids.organization_id, 'org1');
    assert.strictEqual(row.ids.user_id, 'u1');
    assert.strictEqual(row.ids.agent_id, 'ag1');
    assert.strictEqual(row.ids.agent_name, 'Researcher');
    assert.strictEqual(row.ids.conversation_id, 'c1');
    assert.strictEqual(row.probe.peers.length, 1);
    assert.strictEqual(row.probe.peers[0].ip, '127.0.0.1');
    assert.ok(Number.isFinite(row.durationMs));
});

test('a throwing tool still gets its row (status error) and the throw is unchanged', async () => {
    const boom = new Error('upstream 500');
    const executeTool = createEgressChokepoint(async () => { await fetchingTool(); throw boom; }, { logToolEgress: log });
    await assert.rejects(executeTool('github_create_issue', {}, { userId: 'u1' }), (e) => e === boom);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].error, boom);
    assert.strictEqual(rows[0].probe.peers.length, 1, 'the bytes had left before it failed');
    assert.strictEqual(rows[0].source, 'tool_dispatch', 'an unattributed caller still gets a row');
});

test('a probe already active: the caller owns the row, the chokepoint just runs', async () => {
    const executeTool = createEgressChokepoint(fetchingTool, { logToolEgress: log });
    const { probe } = await probeApi.runWithProbe(() => executeTool('gmail_list_messages', {}, { userId: 'u1' }));
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(probe.peers.length, 1, 'the traffic lands on the caller\'s probe');
});

test('egress: false opts a UI-only read out', async () => {
    const executeTool = createEgressChokepoint(fetchingTool, { logToolEgress: log });
    assert.strictEqual(await executeTool('nextcloud_tables_list_columns', {}, { userId: 'u1', egress: false }), 'ok');
    assert.strictEqual(rows.length, 0);
});

test('a stubbed probe module (tests elsewhere) makes the chokepoint inert rather than broken', async () => {
    const stub = { runWithProbe: async (fn) => ({ result: await fn(), probe: null }), markLocal: () => {} };
    const executeTool = createEgressChokepoint(async () => 'plain', { logToolEgress: log, probeApi: stub });
    assert.strictEqual(await executeTool('gmail_list_messages', {}, {}), 'plain');
    assert.strictEqual(rows.length, 0);
});

test('a logger that throws never changes the tool\'s result', async () => {
    const executeTool = createEgressChokepoint(async () => 'fine', { logToolEgress: () => { throw new Error('ledger down'); } });
    assert.strictEqual(await executeTool('maps_search', {}, { userId: 'u1' }), 'fine');
});

test('the asker is the row\'s user; a different integration identity is the acting user', async () => {
    const executeTool = createEgressChokepoint(async () => 'ok', { logToolEgress: log });
    await executeTool('outlook_send', {}, { userId: 'operator', askerUserId: 'asker', session: { user: { organizationId: 'orgS' } } });
    assert.strictEqual(rows[0].ids.user_id, 'asker');
    assert.strictEqual(rows[0].ids.acting_user_id, 'operator');
    assert.strictEqual(rows[0].ids.organization_id, 'orgS');
});

test('the real dispatcher is wired through the chokepoint', async () => {
    const { executeTool } = require('./toolDispatcher');
    // No name: the dispatcher's own guard answers, with no probe and no row.
    const out = await executeTool('', {}, {});
    assert.match(out.error, /no function name/);
});

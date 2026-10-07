/**
 * The DPIA route's chat signals hook: saving the org-wide DPIA under the key
 * 'chat_monitoring' drops the chat signals resolver memo and re-runs its
 * checks (CHAT_MONITORING_CHANGED); any other key, and a refused save, does
 * neither. The handler body itself is untouched.
 *
 * Run: cd server && node --test routes/compliance/dpia.chatMonitoringHook.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');

const { installResolveStub } = require('../../testUtils/stubRequire');

const calls = { invalidated: [], events: [], upserts: [] };
const pass = (req, res, next) => next();

const restore = installResolveStub({
    '../../stores/complianceStore': { addEvidence: async () => ({}), getSettings: async () => ({}) },
    '../../stores/dpiaStore': {
        listForOrg: async () => [],
        getLatestForAgent: async () => null,
        upsertAssessment: async (orgId, agentId, input) => { calls.upserts.push({ orgId, agentId }); return { agent_id: agentId, ...input }; },
    },
    '../../stores/userStore': { hasAnyOrganization: async () => false, getUser: async () => null, logAccessAudit: async () => {} },
    '../../stores/chatSignalStore': {},
    '../../compliance/runner': { runOne: async () => [] },
    '../../db': { getAll: async () => [] },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass, isOrgAdminForOrg: async () => true, isSuperAdmin: () => false },
    './shared': { resolveOrgId: async (req) => req.headers['x-test-org'] || 'default' },
    '../../compliance/evidence/writeFailures': { onEvidenceWriteFailed: () => () => {} },
    '../../core/entitlements/chatMonitoringFlag': { invalidate: (orgId) => calls.invalidated.push(orgId), resolveChatMonitoring: async () => ({}) },
    '../../compliance/events': {
        EVENTS: { CHAT_MONITORING_CHANGED: 'chat_monitoring_changed' },
        emit: (name, payload) => calls.events.push({ name, payload }),
    },
    '../../utils/appPaths': { publicBaseUrl: () => 'https://app.example.test', publicDsrPath: () => '/dsr' },
});
const router = require('./dpia');
const { chatMonitoringDpiaHook } = require('./chatMonitoring');
test.after(() => restore());

let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/compliance', router);
    app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });
test.beforeEach(() => { for (const k of Object.keys(calls)) calls[k].length = 0; });

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const post = (key, body) => fetch(`${baseUrl}/api/compliance/dpia/${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-org': 'orgA' }, body: JSON.stringify(body),
});

test('a saved chat_monitoring DPIA invalidates the resolver and emits CHAT_MONITORING_CHANGED', async () => {
    const res = await post('chat_monitoring', { mode: 'attestation', risk_level: 'medium', expires_at: null });
    assert.equal(res.status, 200);
    await settle();
    assert.deepEqual(calls.upserts, [{ orgId: 'orgA', agentId: 'chat_monitoring' }], 'the handler ran as before');
    assert.deepEqual(calls.invalidated, ['orgA']);
    assert.deepEqual(calls.events, [{ name: 'chat_monitoring_changed', payload: { orgId: 'orgA' } }]);
});

test('a DPIA for any other key does neither', async () => {
    const res = await post('agent-42', { mode: 'attestation', risk_level: 'low' });
    assert.equal(res.status, 200);
    await settle();
    assert.deepEqual(calls.invalidated, []);
    assert.deepEqual(calls.events, []);
});

test('a refused save does neither', async () => {
    const res = await post('chat_monitoring', { mode: 'questionaire' });
    assert.equal(res.status, 400);
    await settle();
    assert.deepEqual(calls.upserts, []);
    assert.deepEqual(calls.invalidated, []);
    assert.deepEqual(calls.events, []);

    // The hook itself: a 4xx answer on the chat_monitoring key changes nothing.
    const res403 = Object.assign(new EventEmitter(), { statusCode: 403 });
    let nexted = false;
    chatMonitoringDpiaHook({ params: { agentId: 'chat_monitoring' }, headers: { 'x-test-org': 'orgA' } }, res403, () => { nexted = true; });
    assert.equal(nexted, true, 'next() at once');
    res403.emit('finish');
    await settle();
    assert.deepEqual(calls.invalidated, []);
    assert.deepEqual(calls.events, []);
});

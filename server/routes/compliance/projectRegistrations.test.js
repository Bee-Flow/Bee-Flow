'use strict';

/**
 * /ropa/projects — the processing record of collaborative projects. Factory
 * router with injected dependencies; projects live in a real Postgres
 * (pglite) so the org scoping is the shipped SQL.
 *
 * Run: cd server && node --test routes/compliance/projectRegistrations.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { serve, assertRefused } = require('../../core/http/routeHarness');
const { applyProjectCheckSchema, queryOf } = require('../../compliance/projects/testSchema');
const { makeProjectRegistrationRouter } = require('./projectRegistrations');

const pg = new PGlite();
const state = { regs: new Map(), evidence: [], reruns: [] };
const store = {
    listSubjectRegistrations: async (orgId) => [...state.regs.values()].filter(r => r.orgId === orgId),
    upsertSubjectRegistration: async (orgId, r) => {
        const row = { orgId, subject_kind: 'project', subject_id: r.subjectId, purpose: r.purpose, lawful_basis: r.lawfulBasis,
            retention_days: r.retentionDays, confirmed_by: r.confirmedBy, confirmed_at: '2026-09-29T12:00:00.000Z' };
        state.regs.set(`${orgId}|${r.subjectId}`, row);
        const { orgId: _o, ...pub } = row;
        return pub;
    },
    deleteSubjectRegistration: async (orgId, _k, id) => state.regs.delete(`${orgId}|${id}`),
    addEvidence: async (row) => { state.evidence.push(row); return { id: 1 }; },
};
let denied = false;
const signalAnswer = () => ({ byProject: new Map([['p1', { kinds: ['health'], sources: ['files'] }], ['p2', { kinds: ['name'], sources: ['content'] }]]), unreadable: [] });
let signalExtra = {};
const api = serve('/api/compliance', makeProjectRegistrationRouter({
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (denied ? res.status(403).json({ error: 'forbidden' }) : next()),
    query: queryOf(pg),
    complianceStore: store,
    signals: { signalsFor: async () => ({ ...signalAnswer(), ...signalExtra }) },
    resolveOrgId: async () => 'org1',
    rerun: (orgId, projectId) => { state.reruns.push([orgId, projectId]); },
}));

before(async () => {
    await applyProjectCheckSchema(pg, { versions: false });
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('p1', 'Clinic', 'u1', 'org1', 'workspace'), ('p2', 'Agency', 'u1', 'org1', 'workspace'),
            ('p3', 'Recorded', 'u1', 'org1', 'workspace'), ('px', 'Elsewhere', 'u9', 'org2', 'workspace');
    `);
});
beforeEach(() => { state.regs.clear(); state.evidence.length = 0; state.reruns.length = 0; denied = false; signalExtra = {}; });
after(async () => { await api.close(); await pg.close(); });

test('the list is the signalled projects plus every recorded one, special categories first', async () => {
    state.regs.set('org1|p3', { orgId: 'org1', subject_id: 'p3', lawful_basis: 'contract' });
    const res = await api.call('GET', '/api/compliance/ropa/projects');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.projects.map(p => p.project_id), ['p1', 'p2', 'p3']);
    assert.strictEqual(res.body.projects[0].special, true);
    assert.strictEqual(res.body.projects[2].registration.lawful_basis, 'contract');
    assert.strictEqual(res.body.complete, true);
});

test('recording a processing record chains ids and the basis only, and re-judges the project', async () => {
    const res = await api.call('PUT', '/api/compliance/ropa/projects/p1', { body: { purpose: 'Treatment notes for Mrs Jansen', lawful_basis: 'legal_obligation', retention_days: 3650 } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.registration.lawful_basis, 'legal_obligation');
    assert.strictEqual(state.evidence.length, 1);
    assert.ok(!JSON.stringify(state.evidence).includes('Jansen'), 'the purpose text stays out of the chain');
    assert.strictEqual(state.evidence[0].payload.has_purpose, true);
    assert.deepStrictEqual(state.reruns, [['org1', 'p1']]);
});

test('another organisation\'s project is 404; removing a record that does not exist is 404', async () => {
    const foreign = await api.call('PUT', '/api/compliance/ropa/projects/px', { body: { lawful_basis: 'contract' } });
    assert.strictEqual(foreign.status, 404);
    assert.strictEqual(state.regs.size, 0);
    const none = await api.call('DELETE', '/api/compliance/ropa/projects/p1');
    assert.strictEqual(none.status, 404);
    await api.call('PUT', '/api/compliance/ropa/projects/p2', { body: { lawful_basis: 'contract' } });
    const removed = await api.call('DELETE', '/api/compliance/ropa/projects/p2');
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(state.regs.size, 0);
});

test('the body is closed and every refusal is a sentence', async () => {
    assertRefused(assert, await api.call('PUT', '/api/compliance/ropa/projects/p1', { body: { lawful_basis: 'because' } }), 'body.lawful_basis', /lawful_basis must be one of/);
    assertRefused(assert, await api.call('PUT', '/api/compliance/ropa/projects/p1', { body: { lawful_basis: 'contract', retention_days: 5 } }), 'body.retention_days');
    assertRefused(assert, await api.call('PUT', '/api/compliance/ropa/projects/p1', { body: { lawful_basis: 'contract', owner: 'x' } }));
    assertRefused(assert, await api.call('PUT', '/api/compliance/ropa/projects/a%20b', { body: { lawful_basis: 'contract' } }), 'params.projectId');
});

test('no session 401, low role 403, nothing written', async () => {
    assert.strictEqual((await api.call('GET', '/api/compliance/ropa/projects', { user: null })).status, 401);
    denied = true;
    assert.strictEqual((await api.call('PUT', '/api/compliance/ropa/projects/p1', { body: { lawful_basis: 'contract' } })).status, 403);
    assert.strictEqual(state.regs.size, 0);
});

test('a signal source past its limit makes the list incomplete, and the page says so', async () => {
    signalExtra = { truncated: ['events'] };
    const res = await api.call('GET', '/api/compliance/ropa/projects');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.complete, false);
});

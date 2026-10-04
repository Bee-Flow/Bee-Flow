const test = require('node:test');
const assert = require('node:assert');
const { tagGate, readGate } = require('./gateMeta');
const { requireCapabilityOrOrgAdmin, settingsOrgIdFor, summaryTemplateOrgIdFor } = require('./capabilityOrOrgAdmin');

function makeGate() {
    const calls = [];
    const gate = tagGate(async (req, res, _next) => { calls.push(req.path); res.statusCode = 403; }, { axis: 'capability', id: 'meeting_notes' });
    return { gate, calls };
}

async function run(mw, req) {
    const res = { statusCode: 200 };
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    return { nexted, status: res.statusCode };
}

const session = { user: { id: 'u1', organizationId: 'orgA' } };

test('an org admin of the named org skips the capability gate', async () => {
    const { gate, calls } = makeGate();
    const mw = requireCapabilityOrOrgAdmin(gate, { orgIdFor: settingsOrgIdFor, isOrgAdminForOrg: async (_req, orgId) => orgId === 'orgA' });
    const out = await run(mw, { method: 'PUT', path: '/orgA', session });
    assert.deepStrictEqual(out, { nexted: true, status: 200 });
    assert.deepStrictEqual(calls, []);
});

test('a non-admin on an org endpoint still meets the capability gate', async () => {
    const { gate, calls } = makeGate();
    const mw = requireCapabilityOrOrgAdmin(gate, { orgIdFor: settingsOrgIdFor, isOrgAdminForOrg: async () => false });
    const out = await run(mw, { method: 'GET', path: '/orgA', session });
    assert.strictEqual(out.nexted, false);
    assert.deepStrictEqual(calls, ['/orgA']);
});

test('personal endpoints never bypass, even for an org admin', async () => {
    const { gate, calls } = makeGate();
    const mw = requireCapabilityOrOrgAdmin(gate, { orgIdFor: settingsOrgIdFor, isOrgAdminForOrg: async () => true });
    await run(mw, { method: 'GET', path: '/user/me', session });
    assert.deepStrictEqual(calls, ['/user/me']);
});

test('a failing admin check falls back to the capability gate', async () => {
    const { gate, calls } = makeGate();
    const warned = [];
    const mw = requireCapabilityOrOrgAdmin(gate, {
        orgIdFor: settingsOrgIdFor,
        isOrgAdminForOrg: async () => { throw new Error('db down'); },
        log: { warn: (m) => warned.push(m) },
    });
    await run(mw, { method: 'PUT', path: '/orgA', session });
    assert.deepStrictEqual(calls, ['/orgA']);
    assert.strictEqual(warned.length, 1);
});

test('the wrapper keeps the capability tag for the route walk', () => {
    const { gate } = makeGate();
    const meta = readGate(requireCapabilityOrOrgAdmin(gate, { orgIdFor: () => null, isOrgAdminForOrg: async () => false }));
    assert.strictEqual(meta.axis, 'capability');
    assert.strictEqual(meta.id, 'meeting_notes');
    assert.strictEqual(meta.orgAdminBypass, true);
});

test('settingsOrgIdFor names only /:orgId', () => {
    assert.strictEqual(settingsOrgIdFor({ path: '/orgA' }), 'orgA');
    assert.strictEqual(settingsOrgIdFor({ path: '/user/me' }), null);
    assert.strictEqual(settingsOrgIdFor({ path: '/user' }), null);
    assert.strictEqual(settingsOrgIdFor({ path: '/' }), null);
});

test('summaryTemplateOrgIdFor separates org administration from personal use', () => {
    const r = (method, path, body) => summaryTemplateOrgIdFor({ method, path, body, session });
    assert.strictEqual(r('GET', '/'), null);
    assert.strictEqual(r('GET', '/org'), 'orgA');
    assert.strictEqual(r('POST', '/', { scope: 'user' }), null);
    assert.strictEqual(r('POST', '/', { scope: 'org' }), 'orgA');
    assert.strictEqual(r('POST', '/', { scope: 'group' }), 'orgA');
    assert.strictEqual(r('PATCH', '/t1'), 'orgA');
    assert.strictEqual(r('DELETE', '/t1'), 'orgA');
    assert.strictEqual(summaryTemplateOrgIdFor({ method: 'GET', path: '/org', session: {} }), null);
});

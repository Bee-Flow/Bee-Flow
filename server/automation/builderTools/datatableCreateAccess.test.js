'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkDatatableCreate } = require('./datatableCreateAccess');

function deps(over = {}) {
    return {
        resolveDatatablePrincipalForUser: async (userId) => ({ userId, orgId: 'orgA', identityError: null }),
        defaultCreateScope: (p) => (p.orgId ? { kind: 'org', id: p.orgId } : { kind: 'user', id: p.userId }),
        hasPermission: async () => true,
        manageDatatablesPermission: () => 'manage_datatables',
        evaluateForRequest: async () => ({}),
        ...over,
    };
}

test('an org member with manage_datatables may create; the result carries principal, scope, hasManage', async () => {
    const r = await checkDatatableCreate({ userId: 'u1', automationOrgId: 'orgA' }, deps());
    assert.deepStrictEqual([r.ok, r.scope, r.hasManage], [true, { kind: 'org', id: 'orgA' }, true]);
    assert.strictEqual(r.principal.userId, 'u1');
});

test('identity_unavailable (503) when the principal cannot be read', async () => {
    for (const resolve of [async () => ({ identityError: 'db down' }), async () => { throw new Error('boom'); }, async () => null]) {
        const r = await checkDatatableCreate({ userId: 'u1' }, deps({ resolveDatatablePrincipalForUser: resolve }));
        assert.deepStrictEqual([r.ok, r.status, r.code], [false, 503, 'identity_unavailable']);
    }
});

test('no_scope (409) when there is nowhere to create the table', async () => {
    const r = await checkDatatableCreate({ userId: 'u1' }, deps({ defaultCreateScope: () => null }));
    assert.deepStrictEqual([r.status, r.code], [409, 'no_scope']);
});

test('manage_datatables_required (403) for an org table without the permission', async () => {
    const r = await checkDatatableCreate({ userId: 'u1' }, deps({ hasPermission: async () => false }));
    assert.deepStrictEqual([r.status, r.code, r.message], [403, 'manage_datatables_required', 'You may not create organisation tables.']);
});

test('a personal scope needs no manage_datatables', async () => {
    const r = await checkDatatableCreate({ userId: 'u1' }, deps({
        resolveDatatablePrincipalForUser: async (userId) => ({ userId, orgId: null }),
        hasPermission: async () => { throw new Error('must not be asked'); },
    }));
    assert.deepStrictEqual([r.ok, r.scope.kind, r.hasManage], [true, 'user', false]);
});

test('datatable_org_mismatch (409) when the automation belongs to another organisation', async () => {
    const r = await checkDatatableCreate({ userId: 'u1', automationOrgId: 'orgB' }, deps());
    assert.deepStrictEqual([r.status, r.code], [409, 'datatable_org_mismatch']);
    const none = await checkDatatableCreate({ userId: 'u1', automationOrgId: null }, deps());
    assert.strictEqual(none.ok, true, 'an automation without an org is not a mismatch');
});

test('training_required (403) only when a request is given and the datatables area is enforced and unmet', async () => {
    const enforced = { datatables: { enforced: true, satisfied: false, courseTitle: 'Datatables 101' } };
    const asked = [];
    const d = deps({ evaluateForRequest: async (req) => { asked.push(req); return enforced; } });
    const noReq = await checkDatatableCreate({ userId: 'u1' }, d);
    assert.strictEqual(noReq.ok, true);
    assert.strictEqual(asked.length, 0, 'training reads the session, so it needs the request');
    const r = await checkDatatableCreate({ userId: 'u1', req: { session: {} } }, d);
    assert.deepStrictEqual([r.status, r.code], [403, 'training_required']);
    assert.match(r.message, /Datatables 101/);
    const satisfied = await checkDatatableCreate({ userId: 'u1', req: {} }, deps({ evaluateForRequest: async () => ({ datatables: { enforced: true, satisfied: true } }) }));
    assert.strictEqual(satisfied.ok, true);
    const broken = await checkDatatableCreate({ userId: 'u1', req: {} }, deps({ evaluateForRequest: async () => { throw new Error('x'); } }));
    assert.strictEqual(broken.ok, true, 'fails open like the route gate');
});

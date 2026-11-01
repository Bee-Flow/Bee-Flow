'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAdminOrgId, requestError } = require('./routeHelpers');
const { StoreInputError } = require('../../stores/lib/storeInputError');
const { HttpError } = require('../../core/http/errors');

const req = (id) => ({ session: id ? { user: { id } } : undefined });
const deps = (org, mode = 'cloud', fail = false) => ({
    getUser: async () => { if (fail) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); return { organizationId: org }; },
    mode: () => mode,
});

test('an admin reads their home organisation; without one only a single-tenant install falls back to default', async () => {
    assert.equal(await resolveAdminOrgId(req('u1'), deps('org_a')), 'org_a');
    assert.equal(await resolveAdminOrgId(req('u1'), deps(null, 'self-hosted')), 'default');
    await assert.rejects(resolveAdminOrgId(req('u1'), deps(null, 'cloud')), (e) => e instanceof HttpError && e.status === 403);
});

test('no session is a 401 and a failed lookup a 503, never another tenant', async () => {
    await assert.rejects(resolveAdminOrgId(req(null), deps('org_a')), (e) => e instanceof HttpError && e.status === 401);
    await assert.rejects(resolveAdminOrgId(req('u1'), deps('org_a', 'cloud', true)), (e) => e instanceof HttpError && e.status === 503 && /ECONNREFUSED/.test(e.message));
});

test('refused input becomes a 400 with its message; faults pass through untouched', () => {
    const bad = requestError(new StoreInputError('invalid channel "fax"'));
    assert.ok(bad instanceof HttpError);
    assert.equal(bad.status, 400);
    assert.equal(bad.message, 'invalid channel "fax"');
    const fault = new Error('relation does not exist');
    assert.equal(requestError(fault), fault);
    const http = new HttpError(503, 'email_unavailable', 'email service unavailable');
    assert.equal(requestError(http), http);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMicrosoftSessionMiddleware } = require('./microsoftSession');
const identity = { azureTenantId: '11111111-1111-1111-1111-111111111111',
    azureUserId: '22222222-2222-2222-2222-222222222222', revision: '4' };
const login = () => ({ isAuthenticated: true, oauthProvider: 'microsoft', microsoftIdentityVersion: 2,
    microsoftLoginIdentity: { ...identity }, user: { id: 'local' } });
async function invoke(session, binding, middleware) {
    let destroyed = false, nexted = false;
    const req = { session: { ...session, destroy: cb => { destroyed = true; cb(); } } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const gate = middleware || createMicrosoftSessionMiddleware({ getIdentityBinding: async () => binding });
    await gate(req, res, () => { nexted = true; });
    return { req, res, destroyed, nexted };
}
test('Microsoft cookie and bridged logins require the exact current identity and revision', async () => {
    assert.equal((await invoke(login(), identity)).nexted, true);
    for (const binding of [null, { ...identity, azureTenantId: null }, { ...identity, azureUserId: identity.azureTenantId },
        { ...identity, azureTenantId: identity.azureUserId }, { ...identity, revision: '6' }]) {
        const result = await invoke(login(), binding);
        assert.equal(result.res.statusCode, 401);
        assert.equal(result.res.body.code, 'sso_reauthentication_required');
        assert.equal(result.nexted, false);
        assert.equal(result.destroyed, true);
    }
});
test('changing or disconnecting integration credentials cannot hide a Microsoft login', async () => {
    for (const fields of [{ oauthProvider: 'google', oauthTokenSource: 'connector' },
        { oauthProvider: 'microsoft', oauthTokenSource: 'connector' }, { oauthProvider: undefined }]) {
        const result = await invoke({ ...login(), ...fields }, { ...identity, revision: '6' });
        assert.equal(result.res.statusCode, 401);
        assert.equal(result.nexted, false);
    }
});
test('legacy logins and incomplete Microsoft session proofs are refused before a database lookup', async () => {
    const gate = createMicrosoftSessionMiddleware({ getIdentityBinding: async () => { throw new Error('must not be called'); } });
    for (const session of [{ isAuthenticated: true, oauthProvider: 'microsoft', user: { id: 'local' } },
        { ...login(), microsoftLoginIdentity: undefined },
        { ...login(), microsoftLoginIdentity: { ...identity, azureTenantId: 'common' } },
        { ...login(), microsoftLoginIdentity: { ...identity, revision: undefined } },
        { ...login(), user: undefined }]) {
        assert.equal((await invoke(session, null, gate)).res.statusCode, 401);
    }
});
test('local login with Microsoft connector credentials, other providers and anonymous sessions keep working', async () => {
    const gate = createMicrosoftSessionMiddleware({ getIdentityBinding: async () => { throw new Error('must not be called'); } });
    for (const session of [{}, { isAuthenticated: true, user: { id: 'local' } },
        { isAuthenticated: true, oauthProvider: 'google', user: { id: 'local' } },
        { isAuthenticated: true, oauthProvider: 'microsoft', oauthTokenSource: 'connector', user: { id: 'local' } }]) {
        assert.equal((await invoke(session, null, gate)).nexted, true);
    }
});
test('database errors refuse access without destroying a valid login; validation is shared only within one request', async () => {
    let reads = 0;
    const gate = createMicrosoftSessionMiddleware({ getIdentityBinding: async () => { reads++; return identity; } });
    const result = await invoke(login(), identity, gate);
    await gate(result.req, result.res, () => {});
    assert.equal(reads, 1);
    await invoke(login(), identity, gate);
    assert.equal(reads, 2);
    const failure = await invoke(login(), null, createMicrosoftSessionMiddleware({ getIdentityBinding: async () => { throw new Error('database unavailable'); } }));
    assert.equal(failure.res.statusCode, 503);
    assert.equal(failure.nexted, false);
    assert.equal(failure.destroyed, false);
});

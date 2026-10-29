'use strict';

/**
 * The steps of a custom-integration run (customIntegrationSteps.js): the
 * credential checks against a fake connection store, the header denylist,
 * and the shaping of the vendor's answer.
 *
 * Run: cd server && node --test integrations/customIntegrationSteps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveRunCredentials, requestHeaders, shapeResponse } = require('./customIntegrationSteps');

const INTEGRATION = { id: 'int1', slug: 'abcd1234' };
const RUN = { integration: INTEGRATION, connectionOverrideId: null, userId: 'u1', userOrg: 'org1', integrationOrg: 'org1', baseOrigin: 'https://api.example.test' };
const GOOD = { id: 'c1', provider: 'custom:int1', status: 'active', orgId: 'org1', secretMeta: { boundOrigin: 'https://api.example.test' }, secret: { token: 'supersecret' } };

/** A connection store answering with `conn` and resolving to `resolution`. */
function fakeStore(conn, resolution = { available: true, connectionId: 'c1' }) {
    const calls = [];
    return {
        calls,
        getConnectionWithSecret: async (id) => { calls.push(['get', id]); return conn; },
        resolveConnectionForRun: async (q) => { calls.push(['resolve', q]); return resolution; },
        resolveOrgId: (o) => o || 'personal',
    };
}

test('resolveRunCredentials: the resolved connection and its secret', async () => {
    const store = fakeStore(GOOD);
    assert.deepEqual(await resolveRunCredentials(store, RUN), { connection: GOOD, secret: { token: 'supersecret' } });
    assert.deepEqual(store.calls[0], ['resolve', { runningUserId: 'u1', runningUserOrgId: 'org1', runningUserGroups: [], ownerUserId: 'u1', provider: 'custom:int1' }]);
});

test('resolveRunCredentials: every refusal', async () => {
    const refusal = async (conn, run = RUN, resolution) => (await resolveRunCredentials(fakeStore(conn, resolution), run)).refusal;
    assert.match(await refusal(GOOD, RUN, { available: false }), /^No credentials connected/);
    assert.match(await refusal({ ...GOOD, provider: 'custom:other' }, { ...RUN, connectionOverrideId: 'c9' }), /does not belong to this integration/);
    assert.match(await refusal({ ...GOOD, status: 'revoked' }), /credentials are unavailable/);
    assert.match(await refusal(null), /credentials are unavailable/);
    assert.match(await refusal({ ...GOOD, orgId: 'org2' }), /belong to a different organization/);
    assert.match(await refusal({ ...GOOD, secretMeta: { boundOrigin: 'https://evil.example.test' } }), /bound to a different API host/);
    assert.match(await refusal({ ...GOOD, secret: null }), /could not be read/);
});

test('resolveRunCredentials: a named connection skips the run resolution', async () => {
    const store = fakeStore(GOOD);
    await resolveRunCredentials(store, { ...RUN, connectionOverrideId: 'c1' });
    assert.deepEqual(store.calls, [['get', 'c1']]);
});

test('requestHeaders: definition then tool headers, the denylist applied again', () => {
    const def = { api: { defaultHeaders: { Accept: 'application/json', Host: 'evil', 'X-Forwarded-For': '1.2.3.4' } } };
    const tool = { headers: { 'X-Api-Version': '2', Authorization: 'Bearer stolen', 'bad header': 'x', 'X-Num': 3 } };
    assert.deepEqual(requestHeaders(def, tool), { Accept: 'application/json', 'X-Api-Version': '2' });
});

/** A response with a content type. */
const resp = (type, status = 200) => ({ status, headers: { get: (h) => (h === 'content-type' ? type : null) } });

test('shapeResponse: JSON cut to resultPath, scrubbed and budgeted', () => {
    const raw = Buffer.from(JSON.stringify({ data: { items: [1, 2], token: 'supersecret' } }));
    assert.deepEqual(shapeResponse(resp('application/json'), raw, { resultPath: 'data.items' }, 30000, []), { status: 200, result: '[1,2]' });
    const whole = shapeResponse(resp('application/vnd.api+json'), raw, { resultPath: 'data.missing' }, 30000, ['supersecret']);
    assert.equal(whole.result, '{"data":{"items":[1,2],"token":"[redacted:credential]"}}');
    const cut = shapeResponse(resp('application/json'), raw, {}, 10, []);
    assert.equal(cut.truncated, true);
    assert.match(cut.message, /^Response truncated to 10 characters/);
    assert.deepEqual(shapeResponse(resp('application/json'), Buffer.from('{oops'), {}, 100, []), { refusal: 'The API returned invalid JSON.' });
});

test('shapeResponse: text is budgeted, anything else is metadata only', () => {
    assert.deepEqual(shapeResponse(resp('text/plain'), Buffer.from('hello'), {}, 100, []), { status: 200, result: 'hello' });
    assert.deepEqual(shapeResponse(resp('application/pdf'), Buffer.from('%PDF'), {}, 100, []), { status: 200, contentType: 'application/pdf', bytes: 4 });
    assert.deepEqual(shapeResponse(resp(null), Buffer.from('x'), {}, 100, []), { status: 200, contentType: 'unknown', bytes: 1 });
});

// @typecheck
/**
 * nextcloud_request: the generic OCS / WebDAV call of an automation.
 *
 *   - paths: only on the Nextcloud host, under the four proxied prefixes, no
 *     traversal in any spelling, credential and trust paths refused for every
 *     method;
 *   - writes: only the positive allow-list (own Files tree, named app paths);
 *   - identity: the uid comes from the resolved Nextcloud identity, never from
 *     the arguments;
 *   - only inside an automation run, and never in the chat toolset;
 *   - dry run: a GET / PROPFIND / REPORT is a read, every other method a write.
 *
 * Run: cd server && node --test integrations/nextcloudRequestTool.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../testUtils/routeHarness').recordDb();
const { executeNextcloudRequest, checkRequestTarget, normalisePath } = require('./nextcloudRequestTool.mts');
const { isSideEffect, effectOf } = require('../core/automationModel/sideEffectMap');
const { isSideEffectCall } = require('../core/automationModel/sideEffectCall.mts');
const { executeNextcloudTool, NEXTCLOUD_TOOLS, NEXTCLOUD_CATALOG_TOOLS } = require('./nextcloudTools');
const ncClient = require('./nextcloudClient');

const BASE = 'https://nc.example.test';
const RUN = { runId: 'run-1' };

/**
 * @param {{ status?: number, contentType?: string, body?: string }} [answer]
 */
function ctxFor(answer = {}) {
    /** @type {{ url: string, method: string, headers: Record<string, string>, body?: string }[]} */
    const calls = [];
    const status = answer.status ?? 200;
    const ncFetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
        calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({ 'content-type': answer.contentType ?? 'application/json' }),
            body: undefined,
            text: async () => answer.body ?? '{"ocs":{"meta":{"statuscode":200},"data":{"ok":1}}}',
        };
    };
    return { calls, ctx: { baseUrl: BASE, ncFetch, authError: 'AUTH', uid: 'alice', root: `${BASE}/remote.php/dav/files/alice`, runScope: RUN } };
}

test('a GET on an OCS path goes to the Nextcloud host with the OCS headers and parses JSON', async () => {
    const { ctx, calls } = ctxFor();
    const out = await executeNextcloudRequest({ method: 'get', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares', query: { format: 'json', reshares: true } }, ctx);
    assert.deepStrictEqual(out, { status: 200, ok: true, contentType: 'application/json', body: { ocs: { meta: { statuscode: 200 }, data: { ok: 1 } } }, truncated: false });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, `${BASE}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&reshares=true`);
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(calls[0].headers['ocs-apirequest'], 'true');
    assert.strictEqual(calls[0].headers.accept, 'application/json');
});

test('a WebDAV answer comes back as text; segments are encoded once', async () => {
    const { ctx, calls } = ctxFor({ status: 207, contentType: 'application/xml', body: '<d:multistatus/>' });
    const out = await executeNextcloudRequest({ method: 'PROPFIND', path: '/remote.php/dav/files/alice/My Reports/Q3%20draft.md', headers: { Depth: '1' } }, ctx);
    assert.strictEqual(/** @type {any} */ (out).body, '<d:multistatus/>');
    assert.strictEqual(calls[0].url, `${BASE}/remote.php/dav/files/alice/My%20Reports/Q3%20draft.md`);
    assert.strictEqual(calls[0].headers.depth, '1');
});

test('an object body is sent as JSON', async () => {
    const { ctx, calls } = ctxFor();
    await executeNextcloudRequest({ method: 'POST', path: '/ocs/v2.php/apps/spreed/api/v1/chat/abc123', body: { message: 'Done' } }, ctx);
    assert.strictEqual(calls[0].body, '{"message":"Done"}');
    assert.strictEqual(calls[0].headers['content-type'], 'application/json');
});

test('a 4xx answer fails the call with its status', async () => {
    const { ctx } = ctxFor({ status: 404, body: '{"ocs":{"meta":{"statuscode":404}}}' });
    const out = /** @type {any} */ (await executeNextcloudRequest({ method: 'GET', path: '/ocs/v2.php/apps/forms/api/v3/forms/9' }, ctx));
    assert.match(out.error, /404/);
    assert.strictEqual(out.status, 404);
});

const REFUSED_PATHS = [
    ['https://evil.example/ocs/v2.php/cloud/user', 'an absolute URL'],
    ['//evil.example/ocs/v2.php/cloud/user', 'a protocol-relative URL'],
    ['ocs/v2.php/cloud/user', 'a relative path'],
    ['/ocs/v2.php/../../etc/passwd', 'a ".." segment'],
    ['/ocs/v2.php/%2e%2e/remote.php', 'an encoded ".." segment'],
    ['/remote.php/dav/files/alice/a%2f..%2fb', 'an encoded slash'],
    ['/remote.php/dav/files/alice/%252e%252e/x', 'a double-encoded segment'],
    ['/remote.php/dav/files/alice/./x', 'a "." segment'],
    ['/ocs/v2.php//apps/x', 'an empty segment'],
    ['/ocs/v2.php/apps\\x', 'a backslash'],
    ['/ocs/v2.php/cloud/user?format=json', 'a query in the path'],
    ['/ocs/v2.php/cloud/user#x', 'a fragment'],
    ['/ocs/v2.php/cloud/user\r\nX: y', 'control characters'],
    ['/status.php', 'a path outside the four prefixes'],
    ['/index.php/login/v2', 'the login flow'],
    ['/ocs/v2.php/core/getapppassword', 'the app-password endpoint'],
    ['/ocs/v1.php/core/apppassword/rotate', 'the app-password rotation'],
    ['/OCS/V2.PHP/CORE/GETAPPPASSWORD', 'the app-password endpoint in capitals'],
    ['/index.php/apps/oauth2/api/v1/token', 'the OAuth2 token endpoint'],
    ['/ocs/v2.php/apps/oauth2/api/v1/clients', 'the OAuth2 clients'],
    ['/index.php/apps/app_api/proxy/flow/api', 'AppAPI'],
    ['/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks', 'the webhook registrations'],
    ['/ocs/v2.php/apps/provisioning_api/api/v1/config/apps', 'the provisioning API'],
    ['/index.php/apps/settings/admin/mailsettings', 'the settings app'],
];
for (const [path, what] of REFUSED_PATHS) {
    test(`a GET is refused for ${what}, and nothing is sent`, async () => {
        const { ctx, calls } = ctxFor();
        const out = /** @type {any} */ (await executeNextcloudRequest({ method: 'GET', path }, ctx));
        assert.ok(typeof out.error === 'string' && out.error.length > 0, `refused: ${path}`);
        assert.deepStrictEqual(calls, []);
    });
}

const REFUSED_WRITES = [
    ['POST', '/ocs/v2.php/cloud/users', 'creating a user'],
    ['PUT', '/ocs/v2.php/cloud/users/bob', 'editing a user'],
    ['DELETE', '/ocs/v2.php/cloud/users/bob', 'deleting a user'],
    ['POST', '/ocs/v2.php/cloud/groups', 'creating a group'],
    ['POST', '/ocs/v1.php/cloud/users/bob/subadmins', 'making a group admin'],
    ['DELETE', '/ocs/v2.php/apps/files_sharing/api/v1/shares/12', 'revoking a share'],
    ['PUT', '/remote.php/dav/files/bob/x.txt', "writing another user's files"],
    ['DELETE', '/remote.php/dav/files/alice/', 'deleting the root of the own tree'],
    ['PUT', '/remote.php/dav/calendars/alice/personal/x.ics', 'a write outside the allow-list'],
    ['POST', '/ocs/v2.php/apps/files/api/v1/settings', 'an unlisted OCS app'],
    ['PATCH', '/ocs/v2.php/apps/spreed/api/v1/chat/abc', 'a method the rule does not name'],
];
for (const [method, path, what] of REFUSED_WRITES) {
    test(`${method} is refused for ${what}`, async () => {
        const { ctx, calls } = ctxFor();
        const out = /** @type {any} */ (await executeNextcloudRequest({ method, path }, ctx));
        assert.ok(typeof out.error === 'string', `refused: ${method} ${path}`);
        assert.deepStrictEqual(calls, []);
    });
}

test('writes on the allow-list go through', () => {
    for (const [method, path] of [
        ['PUT', '/remote.php/dav/files/alice/Reports/q3.txt'],
        ['MKCOL', '/remote.php/dav/files/alice/Reports/2026'],
        ['DELETE', '/remote.php/dav/files/alice/Reports/old.txt'],
        ['POST', '/ocs/v2.php/apps/spreed/api/v1/chat/abc123'],
        ['POST', '/ocs/v1.php/apps/files_sharing/api/v1/shares'],
        ['PUT', '/ocs/v2.php/apps/files_sharing/api/v1/shares/12'],
        ['POST', '/index.php/apps/deck/api/v1.0/boards/1/stacks/2/cards'],
        ['PUT', '/remote.php/dav/systemtags-relations/files/42/7'],
    ]) {
        assert.deepStrictEqual(checkRequestTarget(method, path, 'alice').ok, true, `${method} ${path}`);
    }
});

test('a method outside the set is refused', () => {
    for (const method of ['HEAD', 'OPTIONS', 'PROPPATCH', 'LOCK', 'TRACE', '']) {
        assert.strictEqual(checkRequestTarget(method, '/ocs/v2.php/cloud/user', 'alice').ok, false, method);
    }
});

test('the uid comes from the identity: an argument cannot widen the own tree', async () => {
    const { ctx, calls } = ctxFor();
    const out = /** @type {any} */ (await executeNextcloudRequest(/** @type {any} */ ({ method: 'PUT', path: '/remote.php/dav/files/bob/x.txt', body: 'x', uid: 'bob', user: 'bob' }), ctx));
    assert.ok(out.error);
    assert.deepStrictEqual(calls, []);
    // Through the dispatcher too: the uid of the resolved identity, nothing from the call.
    const original = ncClient.resolveAuth;
    /** @type {string[]} */
    const urls = [];
    ncClient.resolveAuth = /** @type {any} */ (async () => ({
        baseUrl: BASE, authError: 'AUTH', uid: 'alice',
        fetch: async (/** @type {string} */ url) => { urls.push(url); return { ok: true, status: 201, headers: new Headers(), text: async () => '' }; },
    }));
    try {
        const refused = /** @type {any} */ (await executeNextcloudTool('nextcloud_request', { method: 'PUT', path: '/remote.php/dav/files/bob/x.txt', body: 'x', uid: 'bob' }, 'u1', {}, { runScope: RUN }));
        assert.ok(refused.error);
        const done = /** @type {any} */ (await executeNextcloudTool('nextcloud_request', { method: 'PUT', path: '/remote.php/dav/files/alice/x.txt', body: 'x' }, 'u1', {}, { runScope: RUN }));
        assert.strictEqual(done.status, 201);
        assert.deepStrictEqual(urls, [`${BASE}/remote.php/dav/files/alice/x.txt`]);
    } finally {
        ncClient.resolveAuth = original;
    }
});

test('MOVE needs a Destination in the own tree, made absolute on the Nextcloud host', async () => {
    const { ctx, calls } = ctxFor({ status: 201 });
    const out = /** @type {any} */ (await executeNextcloudRequest({ method: 'MOVE', path: '/remote.php/dav/files/alice/a.txt', headers: { Destination: '/remote.php/dav/files/alice/Archive/a.txt', Overwrite: 'F' } }, ctx));
    assert.strictEqual(out.status, 201);
    assert.strictEqual(calls[0].headers.destination, `${BASE}/remote.php/dav/files/alice/Archive/a.txt`);
    for (const destination of [undefined, 'https://evil.example/remote.php/dav/files/alice/a.txt', '/remote.php/dav/files/bob/a.txt', '/remote.php/dav/files/alice/../bob/a.txt']) {
        const c = ctxFor({ status: 201 });
        const headers = destination === undefined ? {} : { Destination: destination };
        const r = /** @type {any} */ (await executeNextcloudRequest({ method: 'COPY', path: '/remote.php/dav/files/alice/a.txt', headers }, c.ctx));
        assert.ok(r.error, `refused destination ${destination}`);
        assert.deepStrictEqual(c.calls, []);
    }
});

test('only the listed request headers pass; method tunnelling and credentials are refused', async () => {
    for (const name of ['X-HTTP-Method-Override', 'Authorization', 'Cookie', 'Host', 'AUTHORIZATION-APP-API', 'EX-APP-ID']) {
        const { ctx, calls } = ctxFor();
        const out = /** @type {any} */ (await executeNextcloudRequest({ method: 'GET', path: '/ocs/v2.php/cloud/user', headers: { [name]: 'x' } }, ctx));
        assert.match(out.error, /not allowed/, name);
        assert.deepStrictEqual(calls, []);
    }
    const { ctx } = ctxFor();
    const deep = /** @type {any} */ (await executeNextcloudRequest({ method: 'PROPFIND', path: '/remote.php/dav/files/alice/', headers: { Depth: 'infinity' } }, ctx));
    assert.match(deep.error, /Depth/);
});

test('outside an automation run the tool refuses', async () => {
    const { ctx, calls } = ctxFor();
    const out = /** @type {any} */ (await executeNextcloudRequest({ method: 'GET', path: '/ocs/v2.php/cloud/user' }, { ...ctx, runScope: null, automationId: null }));
    assert.match(out.error, /automation/);
    assert.deepStrictEqual(calls, []);
    const viaAutomation = /** @type {any} */ (await executeNextcloudRequest({ method: 'GET', path: '/ocs/v2.php/cloud/user' }, { ...ctx, runScope: null, automationId: 'a-1' }));
    assert.strictEqual(viaAutomation.status, 200);
});

test('the chat toolset leaves it out; the catalog of the Nextcloud app has it', () => {
    assert.ok(!NEXTCLOUD_TOOLS.some((/** @type {any} */ t) => t.function.name === 'nextcloud_request'));
    assert.ok(NEXTCLOUD_CATALOG_TOOLS.some((/** @type {any} */ t) => t.function.name === 'nextcloud_request'));
    const { findOwnerOfTool } = require('../automation/toolRegistry');
    assert.strictEqual(findOwnerOfTool('nextcloud_request')?.app, 'nextcloud');
});

test('dry-run classification follows the method; the name alone stays a write', () => {
    for (const method of ['GET', 'get', ' PROPFIND ', 'REPORT']) {
        assert.strictEqual(isSideEffectCall('nextcloud_request', { method }), false, method);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'MKCOL', 'MOVE', 'COPY', '', undefined, 7]) {
        assert.strictEqual(isSideEffectCall('nextcloud_request', { method }), true, String(method));
    }
    assert.strictEqual(isSideEffectCall('nextcloud_request', null), true);
    assert.strictEqual(isSideEffect('nextcloud_request'), true);
    assert.strictEqual(effectOf('nextcloud_request'), 'writes');
    // Every other tool keeps its name-level answer.
    assert.strictEqual(isSideEffectCall('nextcloud_list_files', { method: 'POST' }), false);
    assert.strictEqual(isSideEffectCall('nextcloud_delete', { method: 'GET' }), true);
});

test('normalisePath keeps the case of what is sent and checks the lower-cased form', () => {
    const n = /** @type {any} */ (normalisePath('/index.php/apps/Deck/api/v1.0/boards'));
    assert.strictEqual(n.path, '/index.php/apps/Deck/api/v1.0/boards');
    assert.strictEqual(n.lower, '/index.php/apps/deck/api/v1.0/boards');
});

test('the definition declares itself for automation steps only (the agent picker reads it)', () => {
    const { NEXTCLOUD_REQUEST_TOOLS } = require('./nextcloudRequestTool.mts');
    assert.deepStrictEqual(NEXTCLOUD_REQUEST_TOOLS[0].availableTo, ['automation_step']);
});

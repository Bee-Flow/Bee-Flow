// @typecheck
'use strict';

/**
 * The polling pass end to end for a shared Outlook mailbox: the msgraph
 * mail.new row reaches the msgraph poller with a Microsoft session (also for a
 * user whose primary credential is Google), the shared inbox is read at
 * /users/{address}/, the new mail is dispatched to THAT row only, and a
 * refused mailbox is stamped and escalated like any failing poll.
 *
 * Run: node --test automation/triggerBus.sharedMailbox.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

// What boot/featureRegistrations.js does at start-up: the msGraph client the poller asks core for.
require('../integrations/integrationClients');
const triggerBus = require('./triggerBus');

/** @type {any[]} */
let SUBS = [];
let SCOPE = 'Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared';
/** @type {any[]} */
const dispatched = [];
const calls = { /** @type {any[]} */ updates: [], /** @type {string[]} */ increments: [], /** @type {string[]} */ resets: [] };

// The polling pass runs against fakes handed in through its own seam.
triggerBus._setDepsForTests({
    automationStore: {
        getPollingSubscriptions: async () => SUBS,
        updateSubscription: async (/** @type {string} */ id, /** @type {any} */ updates) => { calls.updates.push({ id, updates }); return true; },
        incrementSubscriptionFailures: async (/** @type {string} */ id) => { calls.increments.push(id); return { consecutiveFailures: 1, errorNotifiedAt: null }; },
        resetSubscriptionFailures: async (/** @type {string} */ id) => { calls.resets.push(id); },
    },
    userStore: () => ({ getUser: async () => ({ provider: 'local' }) }),
    // Google first, as buildUserAuth picks it when the user has both.
    automationAuth: () => ({
        buildUserAuth: async () => ({
            accessToken: 'google-at', refreshToken: null, oauthProvider: 'google',
            automationProviders: { google: { accessToken: 'google-at' }, microsoft: { accessToken: 'ms-at', refreshToken: 'ms-rt', scope: SCOPE } },
        }),
        getProviderAuth: async () => null,
    }),
    dispatchToSubscription: () => (/** @type {any} */ sub, /** @type {any} */ ev) => { dispatched.push({ sub: sub.id, ev }); return []; },
});
test.after(() => triggerBus._setDepsForTests());

const CURSOR = JSON.stringify({ t: '2026-10-26T09:00:00Z', ids: [], m: 'shared:' + require('crypto').createHash('sha256').update('team@contoso.com').digest('hex').slice(0, 10) });
const row = () => ({ id: 'shared-sub', userId: 'u1', automationId: 'a1', provider: 'msgraph', eventType: 'mail.new', mode: 'polling', filter: { mailbox: 'team@contoso.com' }, lastCursor: CURSOR });

const realFetch = globalThis.fetch;
/** @type {{ url: string, auth: string }[]} */
let requests = [];
/** @type {() => { status: number, body: any }} */
let answer;
test.beforeEach(() => {
    requests = []; dispatched.length = 0; calls.updates = []; calls.increments = []; calls.resets = [];
    SCOPE = 'Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared';
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
        requests.push({ url: decodeURIComponent(String(url)), auth: init.headers?.Authorization });
        const { status, body } = answer();
        return new Response(JSON.stringify(body), { status });
    });
});
test.afterEach(() => { globalThis.fetch = realFetch; });

test('a new mail in the shared inbox is read with the Microsoft token and dispatched to its own row', async () => {
    answer = () => ({ status: 200, body: { value: [{ id: 'NEW', receivedDateTime: '2026-10-26T09:05:00Z' }] } });
    SUBS = [row()];
    await triggerBus.runPollingPass();
    assert.strictEqual(requests.length, 1);
    assert.ok(requests[0].url.startsWith('https://graph.microsoft.com/v1.0/users/team@contoso.com/mailFolders'), requests[0].url);
    assert.strictEqual(requests[0].auth, 'Bearer ms-at');
    assert.deepStrictEqual(dispatched.map(d => [d.sub, d.ev.payload.resourceData.id, d.ev.payload.mailbox]), [['shared-sub', 'NEW', 'team@contoso.com']]);
    assert.deepStrictEqual(calls.resets, ['shared-sub']);
});

test('no Full Access: nothing fires, the row is stamped and the failure escalated', async () => {
    answer = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } });
    SUBS = [row()];
    await triggerBus.runPollingPass();
    assert.strictEqual(requests.length, 1, 'Graph was asked, and refused');
    assert.deepStrictEqual(dispatched, []);
    assert.deepStrictEqual(calls.increments, ['shared-sub']);
    assert.ok(calls.updates.some(u => u.id === 'shared-sub' && u.updates.lastPolledAt));
});

test('a connection that lost the .Shared scopes is caught at the next tick, before Graph', async () => {
    SCOPE = 'Mail.Read Mail.Send';
    answer = () => ({ status: 200, body: { value: [] } });
    SUBS = [row()];
    await triggerBus.runPollingPass();
    assert.strictEqual(requests.length, 0);
    assert.deepStrictEqual(calls.increments, ['shared-sub']);
});

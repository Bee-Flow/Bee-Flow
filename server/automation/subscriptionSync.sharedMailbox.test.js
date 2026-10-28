// @typecheck strict
/**
 * Activating an Outlook "New email" trigger: the own inbox gets a Graph
 * subscription (webhook) when the install has a public URL; a SHARED mailbox
 * is always polled and never subscribed at Graph, which refuses change
 * notifications on shared mailboxes for delegated access.
 *
 * Run: cd server && node --test automation/subscriptionSync.sharedMailbox.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { syncAppEventSubscription, _setDepsForTests } = require('./subscriptionSync');

/** @type {any[]} */
const created = [];
/** @type {any[]} */
const provisioned = [];
// The store and the trigger bus go in through subscriptionSync's own seam, not the module cache.
_setDepsForTests({
    automationStore: {
        getSubscriptionsForAutomation: async () => [],
        deleteSubscriptionsForAutomation: async () => {},
        createSubscription: async (/** @type {any} */ row) => { const sub = { id: `sub${created.length + 1}`, ...row }; created.push(sub); return sub; },
        updateSubscription: async () => {},
    },
    triggerBus: {
        getPublicBaseUrl: () => 'https://bee.example.test',
        loadSession: async () => ({ oauthProvider: 'microsoft', accessToken: 'ms-at' }),
        provisionSubscription: async (/** @type {any} */ sub) => { provisioned.push(sub.id); return { externalRef: 'g1', expiresAt: 'x', clientState: 'c' }; },
        revokeSubscription: async () => true,
    },
});
test.after(() => _setDepsForTests());
test.beforeEach(() => { created.length = 0; provisioned.length = 0; });

const def = (/** @type {any} */ filter, event = 'mail.new') => ({ trigger: { id: 't1', kind: 'app_event', appEvent: { provider: 'msgraph', event, filter } } });

test('the own inbox is subscribed at Graph (webhook)', async () => {
    await syncAppEventSubscription('a1', 'u1', def(null));
    await syncAppEventSubscription('a2', 'u1', def({ mailbox: 'me' }));
    assert.deepStrictEqual(created.map(s => s.mode), ['webhook', 'webhook']);
    assert.deepStrictEqual(provisioned, ['sub1', 'sub2']);
});

test('a shared mailbox is polled, with its address kept in the row\'s filter, and never subscribed at Graph', async () => {
    await syncAppEventSubscription('a1', 'u1', def({ mailbox: 'team@contoso.com', changeType: 'created' }));
    assert.strictEqual(created[0].mode, 'polling');
    assert.deepStrictEqual(created[0].filter, { mailbox: 'team@contoso.com', changeType: 'created' });
    assert.deepStrictEqual(provisioned, []);
});

test('an address that does not parse is polled too, so the poller reports it instead of a webhook watching the own inbox', async () => {
    await syncAppEventSubscription('a1', 'u1', def({ mailbox: 'team' }));
    assert.strictEqual(created[0].mode, 'polling');
    assert.deepStrictEqual(provisioned, []);
});

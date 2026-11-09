// @typecheck
/**
 * subscriptionSync for a Cowork owner: an agent that starts on a new mail.
 *
 * Run: cd server && node --test automation/subscriptionSync.cowork.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { syncCoworkMailTrigger, revokeCoworkMailTrigger, assertMailTriggerReady, _setDepsForTests } = require('./subscriptionSync');

/** @type {any[]} */ let rows = [];
/** @type {any[]} */ const created = [];
/** @type {any[]} */ const deleted = [];
/** @type {any[]} */ const provisioned = [];
/** @type {any[]} */ const revoked = [];
/** @type {any} */ let session = { oauthProvider: 'microsoft', accessToken: 'ms-at' };
let baseUrl = 'https://bee.example.test';

_setDepsForTests({
    automationStore: {
        getSubscriptionsForCoworkSchedule: async () => rows,
        deleteSubscriptionsForCoworkSchedule: async (/** @type {string} */ id) => { deleted.push(id); rows = []; },
        createSubscription: async (/** @type {any} */ row) => { const sub = { id: `sub${created.length + 1}`, ...row }; created.push(sub); return sub; },
        updateSubscription: async () => {},
    },
    triggerBus: {
        getPublicBaseUrl: () => baseUrl,
        loadSession: async () => session,
        provisionSubscription: async (/** @type {any} */ sub) => { provisioned.push(sub.id); return { externalRef: 'g1', expiresAt: 'x', clientState: 'c' }; },
        revokeSubscription: async (/** @type {any} */ sub) => { revoked.push(sub.externalRef); return true; },
    },
});
test.after(() => _setDepsForTests());
test.beforeEach(() => {
    rows = []; created.length = 0; deleted.length = 0; provisioned.length = 0; revoked.length = 0;
    session = { oauthProvider: 'microsoft', accessToken: 'ms-at' }; baseUrl = 'https://bee.example.test';
});

const schedule = (/** @type {any} */ over = {}) => ({
    id: 'cw1', userId: 'u1', isActive: true, triggerKind: 'app_event',
    trigger: { provider: 'gmail', event: 'mail.new', filter: { from: 'a@b.nl' } }, ...over,
});

test('a Gmail trigger gets a polling row owned by the schedule, with its filter', async () => {
    session = { oauthProvider: 'google', accessToken: 'g-at' };
    await syncCoworkMailTrigger(schedule());
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(
        { c: created[0].coworkScheduleId, a: created[0].automationId, u: created[0].userId, p: created[0].provider, e: created[0].eventType, m: created[0].mode, f: created[0].filter },
        { c: 'cw1', a: undefined, u: 'u1', p: 'gmail', e: 'mail.new', m: 'polling', f: { from: 'a@b.nl' } },
    );
    assert.deepStrictEqual(provisioned, []);
});

test('Outlook: own mailbox is a Graph webhook when there is a public URL, polling without', async () => {
    const trigger = { provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'me' } };
    await syncCoworkMailTrigger(schedule({ trigger }));
    assert.strictEqual(created[0].mode, 'webhook');
    assert.deepStrictEqual(provisioned, ['sub1']);

    created.length = 0; provisioned.length = 0; baseUrl = '';
    await syncCoworkMailTrigger(schedule({ trigger }));
    assert.strictEqual(created[0].mode, 'polling');
    assert.deepStrictEqual(provisioned, []);
});

test('Outlook: a shared mailbox is polled and never subscribed at Graph', async () => {
    await syncCoworkMailTrigger(schedule({ trigger: { provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'team@contoso.com' } } }));
    assert.strictEqual(created[0].mode, 'polling');
    assert.deepStrictEqual(provisioned, []);
});

test('a re-sync replaces the row, revokes the remote subscription and keeps the cursor of the same provider', async () => {
    rows = [{ id: 'old', userId: 'u1', provider: 'msgraph', externalRef: 'ext-old', lastCursor: 'CUR' }];
    await syncCoworkMailTrigger(schedule({ trigger: { provider: 'msgraph', event: 'mail.new', filter: null } }));
    assert.deepStrictEqual(revoked, ['ext-old']);
    assert.deepStrictEqual(deleted, ['cw1']);
    assert.strictEqual(created[0].lastCursor, 'CUR');

    // Another provider starts clean: a Gmail history id means nothing to Graph.
    created.length = 0;
    rows = [{ id: 'old', userId: 'u1', provider: 'msgraph', externalRef: null, lastCursor: 'CUR' }];
    session = { oauthProvider: 'google', accessToken: 'g' };
    await syncCoworkMailTrigger(schedule());
    assert.strictEqual(created[0].lastCursor, null);
});

test('a paused item, or one that is not an event item, has no subscription: revoked', async () => {
    rows = [{ id: 'old', userId: 'u1', provider: 'msgraph', externalRef: 'ext-1' }];
    assert.strictEqual(await syncCoworkMailTrigger(schedule({ isActive: false })), null);
    assert.deepStrictEqual(revoked, ['ext-1']);
    assert.deepStrictEqual(deleted, ['cw1']);
    assert.strictEqual(created.length, 0);

    deleted.length = 0;
    await syncCoworkMailTrigger(schedule({ triggerKind: 'schedule', trigger: null }));
    assert.deepStrictEqual(deleted, ['cw1']);
    assert.strictEqual(created.length, 0);
});

test('revokeCoworkMailTrigger revokes at Graph with the owner of the row, then deletes', async () => {
    rows = [{ id: 'old', userId: 'u9', provider: 'msgraph', externalRef: 'ext-9' }, { id: 'g', userId: 'u9', provider: 'gmail', externalRef: null }];
    await revokeCoworkMailTrigger('cw1');
    assert.deepStrictEqual(revoked, ['ext-9']);
    assert.deepStrictEqual(deleted, ['cw1']);
});

test('no connected account: 409 mail_not_connected and no row', async () => {
    session = null;
    await assert.rejects(syncCoworkMailTrigger(schedule()), (/** @type {any} */ e) => e.status === 409 && e.code === 'mail_not_connected');
    session = { oauthProvider: 'google', accessToken: 'g-at' };
    await assert.rejects(assertMailTriggerReady('u1', { provider: 'msgraph', event: 'mail.new' }), (/** @type {any} */ e) => e.code === 'mail_not_connected');
    assert.strictEqual(created.length, 0);
});

test('only mail.new of Gmail or Outlook is a trigger: 400', async () => {
    await assert.rejects(assertMailTriggerReady('u1', { provider: 'github', event: 'mail.new' }), (/** @type {any} */ e) => e.status === 400);
    await assert.rejects(assertMailTriggerReady('u1', { provider: 'gmail', event: 'label.added' }), (/** @type {any} */ e) => e.status === 400);
});

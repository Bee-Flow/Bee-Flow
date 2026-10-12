/**
 * Notification channel contract — node-audit A15.
 *
 * `channels` was honoured by the executor but never validated or exposed by
 * the form: anything other than the literal 'notification' silently delivered
 * NOTHING and recorded success. The contract now: 'notification'/'inapp' →
 * in-app bell, 'email' → sendRunEmail (quiet skip when no service email is
 * configured), unknown channels filtered + reported, NO known channel at all
 * → loud error. A skipped mail is reported as not delivered, with a reason
 * (BFSF-350), never counted among the delivered channels.
 *
 * Run: node --test core/automationRunner/execNotification.channels.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let bellCalls = [];
let emailCalls = [];

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async (n) => { bellCalls.push(n); return { id: 'n1' }; } });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });
// Mutable per test: the default is a connected service mailbox and an owner
// with an address; the BFSF-350 cases switch one of them off.
let serviceConfigured = true;
let ownerEmail = 'owner@example.com';
mock('../../utils/emailService', {
    getServiceEmailConfig: async () => ({ configured: serviceConfigured }),
    sendServiceEmail: async (m) => { emailCalls.push(m); },
});
mock('../../stores/userStore', { getUser: async () => ({ email: ownerEmail }) });

const { execNotification } = require('./engine');

const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
const ctx = { userId: 'user1', automationTitle: 'My automation' };

test('channels [email] sends email and does NOT create a bell notification', async () => {
    bellCalls = []; emailCalls = [];
    const r = await execNotification({ title: 'Hi', body: 'There', channels: ['email'] }, ctx, state, 'live');
    assert.strictEqual(bellCalls.length, 0);
    assert.strictEqual(emailCalls.length, 1);
    assert.strictEqual(emailCalls[0].to, 'owner@example.com');
    assert.deepStrictEqual(r.output.delivered.channels, ['email']);
});

test('unknown channels are filtered and reported alongside a known one', async () => {
    bellCalls = []; emailCalls = [];
    const r = await execNotification({ title: 'Hi', channels: ['notification', 'slack'] }, ctx, state, 'live');
    assert.strictEqual(bellCalls.length, 1);
    assert.deepStrictEqual(r.output.delivered.channels, ['notification']);
    assert.deepStrictEqual(r.output.delivered.ignoredChannels, ['slack']);
});

test('inapp is an alias for the bell channel', async () => {
    bellCalls = []; emailCalls = [];
    await execNotification({ title: 'Hi', channels: ['inapp'] }, ctx, state, 'live');
    assert.strictEqual(bellCalls.length, 1);
});

test('NO known channel at all throws loudly instead of delivering nothing as success', async () => {
    await assert.rejects(
        () => execNotification({ title: 'Hi', channels: ['slack', 'teams'] }, ctx, state, 'live'),
        (e) => e.errorClass === 'notification_channel_unsupported',
    );
});

test('default (no channels) still delivers the bell — unchanged', async () => {
    bellCalls = [];
    const r = await execNotification({ title: 'Hi' }, ctx, state, 'live');
    assert.strictEqual(bellCalls.length, 1);
    assert.deepStrictEqual(r.output.delivered.channels, ['notification']);
});

test('dry-run reports the filtered channel set without delivering', async () => {
    bellCalls = []; emailCalls = [];
    const r = await execNotification({ title: 'Hi', channels: ['email', 'bogus'] }, ctx, state, 'dry_run');
    assert.strictEqual(bellCalls.length + emailCalls.length, 0);
    assert.deepStrictEqual(r.output.wouldNotify.channels, ['email']);
    assert.deepStrictEqual(r.output.wouldNotify.ignoredChannels, ['bogus']);
});

test('BFSF-350: no service mailbox, email only: not delivered, step skipped with a reason', async () => {
    bellCalls = []; emailCalls = []; serviceConfigured = false;
    try {
        const r = await execNotification({ title: 'Hi', body: 'There', channels: ['email'] }, ctx, state, 'live');
        assert.strictEqual(emailCalls.length, 0);
        assert.strictEqual(bellCalls.length, 0);
        assert.deepStrictEqual(r.output.delivered.channels, []);
        assert.strictEqual(r.output.delivered.skippedChannels.length, 1);
        assert.strictEqual(r.output.delivered.skippedChannels[0].channel, 'email');
        assert.strictEqual(r.output.delivered.skippedChannels[0].reason, 'no_service_email');
        assert.match(r.output.skipped, /service mailbox/);
        assert.strictEqual(r.skippedReason, 'no_service_email');
    } finally { serviceConfigured = true; }
});

test('BFSF-350: owner without an address, bell + email: bell delivered, email reported as skipped', async () => {
    bellCalls = []; emailCalls = []; ownerEmail = null;
    try {
        const r = await execNotification({ title: 'Hi', channels: ['notification', 'email'] }, ctx, state, 'live');
        assert.strictEqual(bellCalls.length, 1);
        assert.strictEqual(emailCalls.length, 0);
        assert.deepStrictEqual(r.output.delivered.channels, ['notification']);
        assert.deepStrictEqual(r.output.delivered.skippedChannels.map(c => [c.channel, c.reason]), [['email', 'no_owner_email']]);
        assert.strictEqual(r.skippedReason, undefined, 'the bell went out, so the step is not skipped');
        assert.strictEqual(r.output.skipped, undefined);
    } finally { ownerEmail = 'owner@example.com'; }
});

test('BFSF-350: a mail that did go out carries no skippedChannels', async () => {
    bellCalls = []; emailCalls = [];
    const r = await execNotification({ title: 'Hi', channels: ['email'] }, ctx, state, 'live');
    assert.strictEqual(emailCalls.length, 1);
    assert.strictEqual(r.output.delivered.skippedChannels, undefined);
    assert.strictEqual(r.skippedReason, undefined);
});

'use strict';

/**
 * Latest-match lookups that seed manual runs with a real payload, driven
 * through a fake ctx (no Gmail, no Nextcloud, no DB).
 *
 * Run: node --test automation/triggerBus/latestMatch.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { fetchLatestGmailMatch, fetchLatestNextcloudMatch } = require('./latestMatch');

test('fetchLatestGmailMatch returns null without an access token', async () => {
    const ctx = { loadSession: async () => ({ automationProviders: {} }) };
    assert.strictEqual(await fetchLatestGmailMatch(ctx, 'u1', { from: 'boss@example.com' }), null);
});

test('fetchLatestGmailMatch pre-filters with q and returns the first candidate the matcher accepts', async () => {
    let listed = null;
    const headers = {
        m1: [{ name: 'From', value: 'Someone <x@example.com>' }, { name: 'Subject', value: 'hello' }],
        m2: [{ name: 'From', value: 'Boss <boss@example.com>' }, { name: 'Subject', value: 'Invoice 42' }],
    };
    const gmail = {
        users: {
            messages: {
                list: async (p) => { listed = p; return { data: { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] } }; },
                get: async ({ id }) => ({ data: { threadId: id === 'm1' ? 't1' : 't2', payload: { headers: headers[id] } } }),
            },
        },
    };
    const ctx = {
        loadSession: async () => ({ accessToken: 'tok' }),
        googleClient: () => ({ createGoogleApiClient: async () => gmail }),
        gmailTools: () => ({ extractAttachments: () => [] }),
    };
    const payload = await fetchLatestGmailMatch(ctx, 'u1', { subjectContains: 'invoice' });
    assert.strictEqual(listed.q, 'subject:"invoice"');
    assert.strictEqual(listed.maxResults, 10);
    assert.strictEqual(payload.messageId, 'm2');
    assert.strictEqual(payload.threadId, 't2');
    assert.strictEqual(payload.subject, 'Invoice 42');
});

test('fetchLatestNextcloudMatch returns the newest activity that matches the trigger filter', async () => {
    const activities = [
        { id: 1, type: 'file_created', subject: 'created', objectName: '/Invoices/a.pdf' },
        { id: 3, type: 'file_created', subject: 'created', objectName: '/Other/c.pdf' },
        { id: 2, type: 'file_created', subject: 'created', objectName: '/Invoices/b.pdf' },
    ];
    const ctx = {
        loadSession: async () => ({ accessToken: 'tok' }),
        ncScopeGuard: () => ({ guardedNcCall: async (_n, _a, _c, run) => run() }),
        nextcloudActivityTools: () => ({ executeNextcloudActivityTool: async () => ({ activities: activities.slice() }) }),
    };
    const payload = await fetchLatestNextcloudMatch(ctx, 'latest-match-user', 'file.new', { inFolder: '/Invoices/' });
    assert.strictEqual(payload.activityId, 2);
    assert.strictEqual(payload.path, '/Invoices/b.pdf');
});

test('fetchLatestNextcloudMatch returns null without credentials', async () => {
    assert.strictEqual(await fetchLatestNextcloudMatch({ loadSession: async () => null }, 'u2', 'file.new', null), null);
});

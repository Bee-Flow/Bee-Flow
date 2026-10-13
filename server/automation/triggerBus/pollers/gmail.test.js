'use strict';

/**
 * Gmail pollers (mail.new, label.added) and the per-message enrichment,
 * driven through a fake ctx and a fake Gmail client. The paginated history
 * walk itself is covered by gmailHistory.test.js.
 *
 * Run: node --test automation/triggerBus/pollers/gmail.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createGmailPollers, fetchGmailMessageMetadata } = require('./gmail');

function gmailCtx(gmail) {
    const updates = [];
    const ctx = {
        store: () => ({ updateSubscription: async (id, u) => { updates.push({ id, ...u }); } }),
        googleClient: () => ({ createGoogleApiClient: async () => gmail }),
        gmailTools: () => ({ extractAttachments: () => [] }),
    };
    return { ctx, updates };
}

const bootstrapGmail = (history) => ({
    users: {
        history: { list: async () => { if (history instanceof Error) throw history; return history; } },
        messages: {
            list: async () => ({ data: { messages: [{ id: 'm-newest' }] } }),
            get: async () => ({ data: { historyId: '500' } }),
        },
        getProfile: async () => ({ data: { historyId: '600' } }),
    },
});

test('mail.new bootstrap anchors the cursor at the newest message and delivers nothing', async () => {
    const { ctx, updates } = gmailCtx(bootstrapGmail(null));
    const out = await createGmailPollers(ctx)['mail.new']({ id: 'g1', lastCursor: null }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 'g1', lastCursor: '500' }]);
});

test('mail.new with an aged-out cursor (404) clears it and re-bootstraps in the same tick', async () => {
    const stale = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
    const { ctx, updates } = gmailCtx(bootstrapGmail(stale));
    const out = await createGmailPollers(ctx)['mail.new']({ id: 'g2', lastCursor: '42' }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 'g2', lastCursor: null }, { id: 'g2', lastCursor: '500' }]);
});

test('label.added with a non-stale error returns [] and keeps the cursor', async () => {
    const { ctx, updates } = gmailCtx(bootstrapGmail(new Error('backend error')));
    const out = await createGmailPollers(ctx)['label.added']({ id: 'g3', lastCursor: '42' }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, []);
});

test('fetchGmailMessageMetadata shapes headers and attachments from ctx.gmailTools()', async () => {
    const gmail = {
        users: {
            messages: {
                get: async (params) => {
                    assert.strictEqual(params.format, 'full');
                    return {
                        data: {
                            threadId: 't1', snippet: 'hi', labelIds: ['INBOX'], historyId: '9',
                            payload: { headers: [{ name: 'From', value: 'Boss <boss@example.com>' }, { name: 'Subject', value: 'Q3' }] },
                        },
                    };
                },
            },
        },
    };
    const ctx = {
        gmailTools: () => ({
            extractAttachments: (_payload, ids) => [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 3, attachmentId: 'att1', ...ids, extra: 'dropped' }],
        }),
    };
    const meta = await fetchGmailMessageMetadata(ctx, gmail, 'm1');
    assert.strictEqual(meta.from, 'Boss <boss@example.com>');
    assert.strictEqual(meta.subject, 'Q3');
    assert.strictEqual(meta.to, null);
    assert.strictEqual(meta.hasAttachment, true);
    assert.deepStrictEqual(meta.attachments, [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 3, attachmentId: 'att1', messageId: 'm1', threadId: 't1' }]);
});

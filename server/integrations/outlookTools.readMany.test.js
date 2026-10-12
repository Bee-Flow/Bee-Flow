'use strict';

/**
 * outlook_read_many: many Outlook emails per Graph request, each one shaped
 * exactly as outlook_read shapes it. A fake graphBatch, no network.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readManyOutlookMessages, shapeOutlookMessage, shapeOutlookAttachments, OUTLOOK_READONLY_TOOLS, isOutlookTool } = require('./outlookTools');

const graphMessage = (id, extra = {}) => ({
    id,
    subject: `Invoice ${id}`,
    from: { emailAddress: { name: 'Billing', address: 'billing@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-10-05T06:00:00Z',
    body: { contentType: 'html', content: `<p>Body of <b>${id}</b></p>` },
    hasAttachments: false,
    conversationId: `conv-${id}`,
    ...extra,
});

/** A graphBatch stand-in answering by url. */
function fakeBatch(answer) {
    const calls = [];
    const batch = async (session, requests) => {
        calls.push(requests);
        return new Map(requests.map(r => [r.id, answer(r.url)]));
    };
    return { batch, calls };
}

const ok = (body) => ({ status: 200, headers: {}, body });

test('the shape outlook_read has always had: names with addresses, HTML stripped, attachments listed apart', () => {
    assert.deepEqual(shapeOutlookMessage(graphMessage('m1')), {
        id: 'm1', from: 'Billing <billing@example.com>', to: 'Me <me@example.com>', cc: '',
        subject: 'Invoice m1', date: '2026-10-05T06:00:00Z', body: 'Body of m1',
        conversationId: 'conv-m1', hasAttachments: false,
    });
    assert.deepEqual(shapeOutlookAttachments([{ id: 'a1', name: 'f.pdf', contentType: 'application/pdf', size: 10 }]), [
        { id: 'a1', filename: 'f.pdf', mimeType: 'application/pdf', size: 10, canOCR: true },
    ]);
});

test('outlook_read_many: one batch for the messages, one for the attachment lists that exist', async () => {
    const { batch, calls } = fakeBatch((url) => {
        const id = /\/me\/messages\/([^/?]+)/.exec(url)[1];
        if (url.includes('/attachments')) return ok({ value: [{ id: `att-${id}`, name: `${id}.pdf`, contentType: 'application/pdf', size: 99 }] });
        return ok(graphMessage(id, { hasAttachments: id === 'm2' }));
    });
    const session = { accessToken: 't' };
    const out = await readManyOutlookMessages(session, { messageIds: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }, { batch });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].map(r => r.url), [
        '/me/messages/m1?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId',
        '/me/messages/m2?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId',
        '/me/messages/m3?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId',
    ]);
    assert.deepEqual(calls[1].map(r => r.url), ['/me/messages/m2/attachments?$select=id,name,contentType,size']);
    assert.deepEqual(out.messages.map(m => m.id), ['m1', 'm2', 'm3']);
    assert.deepEqual(out.messages[0], shapeOutlookMessage(graphMessage('m1')));
    assert.equal('attachments' in out.messages[0], false, 'no attachments key without attachments, as in outlook_read');
    assert.deepEqual(out.messages[1].attachments, [{ id: 'att-m2', filename: 'm2.pdf', mimeType: 'application/pdf', size: 99, canOCR: true }]);
    assert.equal(out.count, 3);
});

test('outlook_read_many: unknown ids are notFound, failures say why, odd ids never reach Graph', async () => {
    const { batch, calls } = fakeBatch((url) => {
        if (url.includes('/gone')) return { status: 404, headers: {}, body: { error: { message: 'The specified object was not found in the store.' } } };
        if (url.includes('/busy')) return { status: 429, headers: {}, body: { error: { message: 'Application is over its MailboxConcurrency limit.' } } };
        return ok(graphMessage('ok'));
    });
    const out = await readManyOutlookMessages({}, { messageIds: ['ok', 'gone', 'busy', '../users/x'] }, { batch });
    assert.equal(calls[0].length, 3, 'the path-like id was never sent');
    assert.deepEqual(out.notFound, ['gone']);
    assert.deepEqual(out.failed, [
        { id: '../users/x', error: 'That is not an Outlook message id.' },
        { id: 'busy', error: 'Application is over its MailboxConcurrency limit.' },
    ]);
    assert.equal(out.error, undefined);
});

test('outlook_read_many: an attachment list that will not load leaves the email readable; nothing readable is an error', async () => {
    const { batch } = fakeBatch((url) => (url.includes('/attachments') ? { status: 500, headers: {}, body: {} } : ok(graphMessage('m1', { hasAttachments: true }))));
    const out = await readManyOutlookMessages({}, { messageIds: ['m1'] }, { batch });
    assert.deepEqual(out.messages[0].attachments, []);
    const failing = fakeBatch(() => ({ status: 503, headers: {}, body: {} }));
    const none = await readManyOutlookMessages({}, { messageIds: ['a', 'b'] }, { batch: failing.batch });
    assert.match(none.error, /Could not read any of the 2 messages: HTTP 503/);
});

test('outlook_read_many: at most 100 per call, and it is a read-only Outlook tool', async () => {
    const { batch, calls } = fakeBatch(() => ok(graphMessage('x')));
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
    const out = await readManyOutlookMessages({}, { messageIds: ids }, { batch });
    assert.equal(calls[0].length, 100);
    assert.equal(out.truncated, true);
    assert.equal(out.totalRequested, 120);
    assert.equal(isOutlookTool('outlook_read_many'), true);
    assert.ok(OUTLOOK_READONLY_TOOLS.some(t => t.function.name === 'outlook_read_many'), 'Outlook (read-only) offers it too');
});

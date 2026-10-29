'use strict';

/**
 * The thread expansion and attachment phases of a mailbox pull
 * (mailboxThreadsAndFiles.js), on the paths that need no provider call:
 * the caps that mark a thread partial, and the per-conversation file dedupe.
 * The provider round-trips are covered through mailboxConnector.test.js.
 *
 * Run: cd server && node --test appStudio/mailboxThreadsAndFiles.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const emailFetch = require('../services/email/fetch');
const { expandThreads, listAttachmentRows, dedupeAttachmentRows } = require('./mailboxThreadsAndFiles');

const IDENTITY = { provider: 'gmail', tokens: {}, onRefresh: () => {}, mailbox: { address: 'desk@example.test' } };

test('expandThreads: a thread past the expansion cap is partial and not fetched', async () => {
    const messages = [
        { provider_message_id: 'm1', provider_thread_id: 't1', thread_key: 'k1' },
        { provider_message_id: 'm2', provider_thread_id: 't2', thread_key: 'k2' },
    ];
    const out = await expandThreads(messages, IDENTITY, {}, { emailFetch, maxExpansions: 0, maxRows: 200 });
    assert.equal(out.messages, messages, 'under the row cap the batch is the same array');
    assert.deepEqual([...out.partialThreads].sort(), ['k1', 'k2']);
});

test('expandThreads: messages without a thread id expand nothing and stay complete', async () => {
    const messages = [{ provider_message_id: 'm1', thread_key: 'k1' }];
    const out = await expandThreads(messages, IDENTITY, {}, { emailFetch, maxExpansions: 25, maxRows: 200 });
    assert.deepEqual(out.messages, messages);
    assert.equal(out.partialThreads.size, 0);
});

test('expandThreads: cutting the batch at the row cap marks the cut threads partial', async () => {
    const messages = [
        { provider_message_id: 'm1', thread_key: 'k1' },
        { provider_message_id: 'm2', thread_key: 'k2' },
        { provider_message_id: 'm3', thread_key: 'k3' },
    ];
    const out = await expandThreads(messages, IDENTITY, {}, { emailFetch, maxExpansions: 25, maxRows: 2 });
    assert.deepEqual(out.messages.map((m) => m.provider_message_id), ['m1', 'm2']);
    assert.deepEqual([...out.partialThreads], ['k3']);
});

test('listAttachmentRows: messages without attachments ask the provider nothing', async () => {
    assert.deepEqual(await listAttachmentRows([{ provider_message_id: 'm1', has_attachments: false }], IDENTITY, {}, emailFetch), []);
});

test('dedupeAttachmentRows: one row per file per conversation, first kept, in order', () => {
    const rows = [
        { thread_key: 'k1', filename: 'invoice.pdf', size: 10, mime_type: 'application/pdf', _parentIndex: 0 },
        { thread_key: 'k1', filename: 'invoice.pdf', size: 10, mime_type: 'application/pdf', _parentIndex: 1 },
        { thread_key: 'k2', filename: 'invoice.pdf', size: 10, mime_type: 'application/pdf', _parentIndex: 2 },
        { thread_key: 'k1', filename: 'invoice.pdf', size: 11, mime_type: 'application/pdf', _parentIndex: 3 },
        { provider_message_id: 'm9', filename: 'a.png', size: 1, mime_type: 'image/png', _parentIndex: 4 },
    ];
    assert.deepEqual(dedupeAttachmentRows(rows).map((r) => r._parentIndex), [0, 2, 3, 4]);
});

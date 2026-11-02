/**
 * An Outlook attachment whose message moved folder is found again through its
 * conversation.
 *
 * Run: cd server && node --test services/email/outlookAttachment.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { fetchOutlookAttachment, conversationIdOf } = require('./outlookAttachment.mts');

const BASE = '/users/info%40acme.nl';
const notFound = () => Object.assign(new Error('Graph API 404: ErrorItemNotFound'), { status: 404, graphCode: 'ErrorItemNotFound' });
const FILE = { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att-new', name: 'tekening.pdf', size: 120, contentBytes: 'JVBERi0=' };

/** A fake Graph: the stored ids are gone, the message lives on under `moved`. */
function graph({ moved = 'msg-moved', attachments = [{ id: 'att-new', name: 'tekening.pdf', size: 120, isInline: false }] } = {}) {
    const calls = [];
    const get = async (path) => {
        calls.push(path);
        if (path.includes('/messages/msg-old/')) throw notFound();
        if (path.includes('$filter=')) return { value: [{ id: 'msg-other', hasAttachments: false }, { id: moved, hasAttachments: true }] };
        if (path.endsWith('/attachments?$select=id,name,size,isInline')) return { value: attachments };
        if (path === `${BASE}/messages/${moved}/attachments/att-new`) return FILE;
        throw new Error(`unexpected ${path}`);
    };
    return { get, calls };
}
const ARGS = { base: BASE, messageId: 'msg-old', attachmentId: 'att-old' };
const HINT = { threadKey: 'outlook:AAQk+conv=', name: 'tekening.pdf', size: 120 };

test('a 404 on a moved message finds the attachment again through its conversation', async () => {
    const g = graph();
    const att = await fetchOutlookAttachment(g.get, { ...ARGS, hint: HINT });
    assert.strictEqual(att, FILE);
    // The filter is percent-encoded, spaces as %20: OData reads '+' literally.
    assert.strictEqual(g.calls[1], `${BASE}/messages?$filter=conversationId%20eq%20'AAQk%2Bconv%3D'&$select=id,hasAttachments&$top=50`);
    assert.ok(!g.calls.some((p) => p.includes('msg-other/attachments')), 'a message without attachments is not read');
});

test('the stored ids are tried first, and a hit costs one call', async () => {
    const calls = [];
    const att = await fetchOutlookAttachment(async (p) => { calls.push(p); return FILE; }, { ...ARGS, hint: HINT });
    assert.strictEqual(att, FILE);
    assert.deepStrictEqual(calls, [`${BASE}/messages/msg-old/attachments/att-old`]);
});

test('no match keeps the original 404: other name, other size, an inline image', async () => {
    for (const attachments of [
        [{ id: 'att-new', name: 'anders.pdf', size: 120 }],
        [{ id: 'att-new', name: 'tekening.pdf', size: 999 }],
        [{ id: 'att-new', name: 'tekening.pdf', size: 120, isInline: true }],
    ]) {
        await assert.rejects(fetchOutlookAttachment(graph({ attachments }).get, { ...ARGS, hint: HINT }), (e) => e.status === 404);
    }
});

test('only a 404 with an Outlook thread key looks further', async () => {
    const g = graph();
    await assert.rejects(fetchOutlookAttachment(g.get, { ...ARGS, hint: { ...HINT, threadKey: 'rfc:<a@b>' } }), (e) => e.status === 404);
    await assert.rejects(fetchOutlookAttachment(g.get, { ...ARGS, hint: null }), (e) => e.status === 404);
    assert.ok(!g.calls.some((p) => p.includes('$filter')));

    const denied = Object.assign(new Error('Graph API 403'), { status: 403, graphCode: 'ErrorAccessDenied' });
    await assert.rejects(fetchOutlookAttachment(async () => { throw denied; }, { ...ARGS, hint: HINT }), (e) => e === denied);
});

test('conversationIdOf reads only Outlook thread keys', () => {
    assert.strictEqual(conversationIdOf('outlook:AAQk'), 'AAQk');
    assert.strictEqual(conversationIdOf('gmail:123'), null);
    assert.strictEqual(conversationIdOf('outlook:'), null);
    assert.strictEqual(conversationIdOf(null), null);
});

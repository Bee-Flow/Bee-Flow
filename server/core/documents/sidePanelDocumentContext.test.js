'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildDirectNote, buildAgentContent, MAX_CONTENT_CHARS } = require('./sidePanelDocumentContext');

const deps = (doc) => ({ documentStore: { getDocument: async (id, userId) => (doc && id === doc.id && userId === 'u1' ? doc : null) } });
const DOC = { id: 'd1', name: 'Offerte\nfoo', docType: 'quote', bodyHtml: '<h1>Titel</h1><p>Hallo <b>wereld</b></p><script>x()</script>' };

test('direct note names the open document; nothing without a panel or when unreadable', async () => {
    const note = await buildDirectNote({ id: 'd1', name: 'client lies' }, 'u1', deps(DOC));
    assert.match(note, /\[DOCUMENT OPEN\] The user has "Offerte foo" \(documentId: d1, type: quote\) open next to the chat\. Read it with document_read/);
    assert.ok(!note.includes('client lies'));
    assert.strictEqual(await buildDirectNote(undefined, 'u1', deps(DOC)), '');
    assert.strictEqual(await buildDirectNote({ id: 5 }, 'u1', deps(DOC)), '');
    assert.strictEqual(await buildDirectNote({ id: 'd1' }, 'other', deps(DOC)), '');
    assert.strictEqual(await buildDirectNote({ id: 'zz' }, 'u1', deps(DOC)), '');
});

test('a failing lookup injects nothing', async () => {
    const boom = { documentStore: { getDocument: async () => { throw new Error('db'); } } };
    assert.strictEqual(await buildDirectNote({ id: 'd1' }, 'u1', boom), '');
});

test('agent content is the plain text, read-only', async () => {
    const out = await buildAgentContent({ id: 'd1' }, 'u1', deps(DOC));
    assert.match(out, /\[DOCUMENT OPEN: Offerte foo\]/);
    assert.match(out, /Titel\nHallo wereld/);
    assert.ok(!out.includes('<') && !out.includes('x()'));
    assert.strictEqual(await buildAgentContent(null, 'u1', deps(DOC)), '');
    assert.strictEqual(await buildAgentContent({ id: 'd1' }, 'other', deps(DOC)), '');
});

test('agent content: spreadsheet gets a note, long text is truncated', async () => {
    const sheet = await buildAgentContent({ id: 's1' }, 'u1', { documentStore: { getDocument: async () => ({ id: 's1', name: 'Sheet', docType: 'spreadsheet', bodyHtml: '' }) } });
    assert.match(sheet, /cell contents are not included/);
    const long = { id: 'd1', name: 'Long', docType: 'report', bodyHtml: `<p>${'a'.repeat(MAX_CONTENT_CHARS + 500)}</p>` };
    const out = await buildAgentContent({ id: 'd1' }, 'u1', deps(long));
    assert.match(out, /…\[truncated, the document is \d+ characters\]/);
    assert.ok(out.length < MAX_CONTENT_CHARS + 400);
});

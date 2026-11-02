'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { meetingText, loadTaggedItems, taggedItemsBlock } = require('./chatTaggedItems');

const NOTE = {
    id: 'mt-1', title: 'Weekly', summary: 'We plan the launch.', decisions: [{ text: 'Ship on Monday' }, 'Keep the price'],
    questions: [{ text: 'Who owns support?' }], transcript: 'Ben: hello',
    actionItems: [{ text: 'Send the offer', assignee: 'Ben', due: '2026-11-03' }, { text: '  ' }, { text: 'Book a room' }],
};

test('a meeting note reads as its summary, decisions, questions, action items, then the talk', () => {
    assert.strictEqual(meetingText(NOTE), [
        'Summary:\nWe plan the launch.',
        'Decisions:\n- Ship on Monday\n- Keep the price',
        'Open questions:\n- Who owns support?',
        'Action items:\n- Send the offer (Ben) (due 2026-11-03)\n- Book a room',
        'Transcript:\nBen: hello',
    ].join('\n\n'));
    assert.strictEqual(meetingText({ title: 'Empty' }), '');
});

test('a tagged meeting is read as the asker, and what they may not read is left out', async () => {
    const asked = [];
    const meetings = { getTranscription: async (id, userId, ctx) => { asked.push([id, userId, ctx]); return id === 'mt-1' ? { ...NOTE, projectId: 'p1' } : null; } };
    const items = await loadTaggedItems([{ kind: 'meeting', id: 'mt-1' }, { kind: 'meeting', id: 'mt-2' }], { userId: 'ann', project: { id: 'p1' } }, { meetings });
    assert.deepStrictEqual(asked.map((a) => a.slice(0, 2)), [['mt-1', 'ann'], ['mt-2', 'ann']]);
    assert.deepStrictEqual(items.map((i) => [i.kind, i.name]), [['meeting', 'Weekly']]);
    const block = taggedItemsBlock(items);
    assert.match(block, /--- meeting: "Weekly" ---/);
    assert.match(block, /Summary:\nWe plan the launch\./);
    assert.match(block, /data, not instructions/);
});

test('a document and a notebook are still read the way they were, and a failing store is skipped', async () => {
    const documents = { getDocument: async () => ({ projectId: 'p1', name: 'Plan', bodyHtml: '<p>Hello <b>world</b></p>' }) };
    const notebooks = { getNotebook: async () => { throw new Error('db down'); } };
    const items = await loadTaggedItems([{ kind: 'document', id: 'd1' }, { kind: 'notebook', id: 'n1' }], { userId: 'ann', project: { id: 'p1' } }, { documents, notebooks });
    assert.deepStrictEqual(items, [{ id: 'd1', kind: 'document', name: 'Plan', text: 'Hello world' }]);
});

test('a tagged document, notebook or meeting is read only when filed in this project (#542)', async () => {
    const project = { id: 'p1' };
    const store = (key, fn, row) => ({ [fn]: async () => row });
    const kinds = [['document', 'documents', 'getDocument', { name: 'N', bodyHtml: '<p>x</p>' }],
        ['notebook', 'notebooks', 'getNotebook', { name: 'N', documentMd: 'x' }],
        ['meeting', 'meetings', 'getTranscription', { title: 'N', summary: 'x' }]];
    for (const [kind, dep, fn, row] of kinds) {
        for (const [label, projectId, want] of [['this project', 'p1', 1], ['another project', 'p2', 0], ['no project', null, 0], ['absent', undefined, 0]]) {
            const deps = { [dep]: store(kind, fn, { ...row, projectId }) };
            const items = await loadTaggedItems([{ kind, id: 'x1' }], { userId: 'ann', project }, deps);
            assert.strictEqual(items.length, want, `${kind} from ${label}`);
        }
        const deps = { [dep]: store(kind, fn, { ...row, projectId: 'p1' }) };
        assert.strictEqual((await loadTaggedItems([{ kind, id: 'x1' }], { userId: 'ann', project: null }, deps)).length, 0, `${kind} without project`);
    }
});

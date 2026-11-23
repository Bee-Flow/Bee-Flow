'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addNote, removeNote, notesOf, MAX_NOTES, MAX_NOTE } = require('./fieldNotes.mts');

const KNOWN = ['price', 'scope'];
const note = (settings, over = {}) => addNote(settings, { id: `n${notesOf(settings).length + 1}`, key: 'price', userId: 'ann', text: 'Leave it.', now: '2026-11-23T09:00:00.000Z', knownKeys: KNOWN, ...over });

test('notes are kept oldest first, at a field or on the whole document', () => {
    let s = note({ sampleValues: { price: 1 } });
    s = note(s, { key: '', userId: 'bob', text: `  ${'x'.repeat(MAX_NOTE + 20)}  ` });
    const notes = notesOf(s);
    assert.deepEqual(notes.map((n) => [n.id, n.key, n.userId]), [['n1', 'price', 'ann'], ['n2', '', 'bob']]);
    assert.equal(notes[1].text.length, MAX_NOTE);
    assert.deepEqual(s.sampleValues, { price: 1 }, 'the values are left alone');
});

test('a note needs words and a field the document has, and a document holds a bounded number', () => {
    assert.throws(() => note({}, { text: '   ' }), (e) => e.status === 422 && e.errorClass === 'field_note_empty');
    assert.throws(() => note({}, { key: 'nope' }), (e) => e.errorClass === 'field_note_unknown_field');
    let s = {};
    for (let i = 0; i < MAX_NOTES; i += 1) s = note(s);
    assert.throws(() => note(s), (e) => e.errorClass === 'field_note_limit');
});

test('only its writer removes a note', () => {
    const s = note(note({}), { userId: 'bob' });
    assert.throws(() => removeNote(s, 'n1', 'bob'), (e) => e.status === 403 && e.errorClass === 'field_note_not_yours');
    const out = removeNote(s, 'n1', 'ann');
    assert.equal(out.removed.id, 'n1');
    assert.deepEqual(notesOf(out.settings).map((n) => n.id), ['n2']);
    assert.equal(removeNote(s, 'gone', 'ann').removed, null);
});

test('notes are read defensively', () => {
    assert.deepEqual(notesOf(null), []);
    assert.deepEqual(notesOf({ fieldNotes: 'x' }), []);
    assert.deepEqual(notesOf({ fieldNotes: [{ id: 'a' }, null, { id: 'b', key: '', userId: 'u', text: 't', at: 'now' }] }).map((n) => n.id), ['b']);
});

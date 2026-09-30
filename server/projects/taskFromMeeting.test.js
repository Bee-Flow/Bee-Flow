'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { matchAssignee, suggestionsFromNote, clock, itemKey, itemTextHash, createdTaskFor } = require('./taskFromMeeting');

const PEOPLE = [
    { id: 'u1', name: 'Anna de Vries' },
    { id: 'u2', name: 'Bram Jansen' },
    { id: 'u3', name: 'Anna Bakker' },
];

test('a name points at a member by full name, or by a first name only one member has', () => {
    assert.strictEqual(matchAssignee('Bram', PEOPLE), 'u2');
    assert.strictEqual(matchAssignee('bram jansen', PEOPLE), 'u2');
    assert.strictEqual(matchAssignee('Anna de Vries', PEOPLE), 'u1');
});

test('an ambiguous, unknown or empty name points at nobody', () => {
    assert.strictEqual(matchAssignee('Anna', PEOPLE), null, 'two Annas');
    assert.strictEqual(matchAssignee('Carla', PEOPLE), null);
    for (const none of ['', 'Unassigned', 'Niet toegewezen', null, undefined]) assert.strictEqual(matchAssignee(none, PEOPLE), null);
});

test('suggestions carry text, member, due date and where in the meeting; created ones are marked', () => {
    const note = {
        id: 'm1',
        actionItems: [
            { id: 'ai-1', text: ' Send the offer ', assignee: 'Bram', due: '2026-11-03', timestamp: 125, done: false },
            { id: 'ai-2', text: 'Book a room', assignee: 'Niet toegewezen', due: 'next week', done: true },
            { id: 'ai-3', text: '' },
            { text: 'no id' },
        ],
    };
    const out = suggestionsFromNote(note, PEOPLE, new Map([['ai-2', 't-9']]));
    assert.deepStrictEqual(out, [
        { itemId: 'ai-1', text: 'Send the offer', assigneeName: 'Bram', suggestedAssigneeId: 'u2', dueDate: '2026-11-03', at: '2:05', done: false, createdTaskId: null },
        { itemId: 'ai-2', text: 'Book a room', assigneeName: 'Niet toegewezen', suggestedAssigneeId: null, dueDate: null, at: '', done: true, createdTaskId: 't-9' },
    ]);
});

test('timestamps read as minutes and seconds, with hours when needed', () => {
    assert.strictEqual(clock(0), '0:00');
    assert.strictEqual(clock(3725), '1:02:05');
    assert.strictEqual(clock(-1), '');
});

test('a first name is matched only when the note holds just a first name', () => {
    assert.strictEqual(matchAssignee('Bram', PEOPLE), 'u2');
    assert.strictEqual(matchAssignee('Bram Visser', PEOPLE), null, 'another Bram is not this Bram');
    assert.strictEqual(matchAssignee('Bram de Boer', [{ id: 'u2', name: 'Bram Jansen' }]), null);
});

test('a made task is found by the item\'s words, so a shifted position is not "already a task"', () => {
    const made = new Map([[itemKey('ai-2', 'Send the offer'), 't-1']]);
    assert.strictEqual(createdTaskFor(made, 'ai-2', '  send the  OFFER '), 't-1', 'same words, same item');
    assert.strictEqual(createdTaskFor(made, 'ai-2', 'Book a room'), null, 'the position now holds another item');
    assert.strictEqual(createdTaskFor(made, 'ai-3', 'Send the offer'), null, 'the same words at another position are not matched');
    const legacy = new Map([['ai-2', 't-0']]);
    assert.strictEqual(createdTaskFor(legacy, 'ai-2', 'anything'), 't-0', 'a task made before the hash existed is found by its id');
    assert.strictEqual(itemTextHash(''), '');
    assert.strictEqual(itemKey('ai-1', ''), 'ai-1');
    const note = { id: 'm1', actionItems: [{ id: 'ai-1', text: 'Book a room' }] };
    assert.strictEqual(suggestionsFromNote(note, PEOPLE, made)[0].createdTaskId, null);
    assert.strictEqual(suggestionsFromNote({ ...note, actionItems: [{ id: 'ai-2', text: 'Send the offer' }] }, PEOPLE, made)[0].createdTaskId, 't-1');
});

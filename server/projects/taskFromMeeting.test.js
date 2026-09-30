'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { matchAssignee, suggestionsFromNote, clock } = require('./taskFromMeeting');

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

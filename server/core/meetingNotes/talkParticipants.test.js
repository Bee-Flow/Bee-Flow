/**
 * knownParticipantCount — de helft van de deelnemerstelling die de Gepland-
 * lijst en de opname-engine ALLEBEI kunnen weten.
 *
 * Waarom dit een eigen bestand is: deze twee gaven ooit een verschillend
 * antwoord op dezelfde vergadering, met een toggle die UIT stond terwijl de
 * opname liep. Deze module is de plek waar dat niet meer kan.
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/talkParticipants.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { knownParticipantCount } = require('./talkParticipants');

const groupRoom = { token: 't1', type: 2 };
const oneToOne = { token: 't1', type: 1 };
const invite = {
    organizer: { email: 'tom@example.com' },
    attendees: [{ email: 'sanne@example.com' }, { email: 'ines@example.com' }],
};

test('de agenda telt in calendar-scope', () => {
    assert.equal(knownParticipantCount({ room: groupRoom, meeting: invite, autoRecordScope: 'calendar' }), 3);
});

test('in scope "all" telt de agenda NIET — de engine kijkt er daar ook niet naar', () => {
    // talkAutoRecord vult `calendarByToken` alleen in calendar-scope. Zou de
    // route hier wél de agenda gebruiken, dan zette hij "Will record" bij een
    // uitnodiging met zes genodigden terwijl de engine op de live telling
    // beslist en bij twee aanwezigen niets doet.
    assert.equal(knownParticipantCount({ room: groupRoom, meeting: invite, autoRecordScope: 'all' }), null);
});

test('een conversatie van type 1 is per definitie twee', () => {
    assert.equal(knownParticipantCount({ room: oneToOne, meeting: null, autoRecordScope: 'calendar' }), 2);
    assert.equal(knownParticipantCount({ room: oneToOne, meeting: null, autoRecordScope: 'all' }), 2);
});

test('de agenda gaat vóór het conversatietype', () => {
    // Een type-1-ruimte met een agenda-afspraak van vier: de agenda wint, in
    // beide kanten dezelfde volgorde.
    const four = { attendees: [1, 2, 3, 4].map(n => ({ email: `p${n}@x.nl` })) };
    assert.equal(knownParticipantCount({ room: oneToOne, meeting: four, autoRecordScope: 'calendar' }), 4);
});

test('een lege deelnemerslijst is ONBEKEND, geen nul', () => {
    // "De agenda vertelde ons niets" is iets anders dan "er komt niemand".
    assert.equal(knownParticipantCount({ room: groupRoom, meeting: { organizer: null, attendees: [] } }), null);
    assert.equal(knownParticipantCount({ room: groupRoom, meeting: null }), null);
    assert.equal(knownParticipantCount({ room: null, meeting: null }), null);
    assert.equal(knownParticipantCount({}), null);
    assert.equal(knownParticipantCount(), null);
});

test('een room zonder type levert niets — raden is hier hetzelfde als fail-open', () => {
    assert.equal(knownParticipantCount({ room: { token: 't1' }, meeting: null }), null);
    assert.equal(knownParticipantCount({ room: { token: 't1', type: '1' }, meeting: null }), null);
});

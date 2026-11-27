'use strict';
/**
 * The meeting notes module's kind of the Adoption report (kinds.meetingNotes.js),
 * against the real schemas (PGlite, ./adoption.testkit.js): recordings, and
 * the makers they make.
 *
 * Run: cd server && node --test stores/adoption/kinds.meetingNotes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

// Three more members in the big group of org A make it five: shown on its own.
kit.use(() => kit.addMembers('a-grp-big', 3));

test('two recordings by one colleague', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.deepEqual(k.meeting.usage, { events: 2, people: 1, label: 'recordings' }, 'two recordings by one colleague');
});

test('the colleague who recorded a meeting is a maker', async () => {
    const s = await kit.store().summary(kit.scope());
    // The owner built their first thing 100 days ago; the colleague's first is
    // the meeting of a week ago.
    assert.deepEqual(s.makers, { total: 2, newInPeriod: 1 });
    const people = await kit.store().people(kit.scope(), { limit: 50, cursor: 0 });
    assert.deepEqual(people.people.find((p) => p.id === 'a-colleague')?.built, { meeting: 2 });
    const groups = await kit.store().groups(kit.scope());
    assert.equal(groups.groups[0].makers, 2);
});

test('private items are counted, never listed: no title of a private recording leaves the store', async () => {
    const meetings = await kit.store().studioItems(kit.scope(), 'meeting', 50);
    assert.equal(meetings?.total, 2);
    assert.deepEqual(meetings?.items.map((i) => i.id), ['a-meet-pub'], 'the private "Standup" recording is not listed');
    const body = JSON.stringify([meetings]);
    assert.ok(!body.includes('Standup'), 'no private title anywhere in the answer');
    assert.ok(!body.includes('a-meet"'), 'nor its id');
});

test('a recording names no owner next to its use: the use is the owner\'s own', async () => {
    const out = await kit.store().studioItems(kit.scope(), 'meeting', 50);
    const item = out?.items[0];
    assert.equal(item?.uses, 1);
    assert.equal(item?.ownerId, null);
    assert.equal(item?.ownerName, null);
    // Other kinds still name the owner: an owner is organisational metadata.
    const agents = await kit.store().studioItems(kit.scope(), 'agent', 50);
    assert.equal(agents?.items[0].ownerName, 'Owner A');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { PUBLIC_VALUES, notePublicValues, publicValuesFor } = require('./publicValues');

test('tokens of nextcloud_talk_* outputs are collected, at any depth', () => {
    const state = {};
    notePublicValues(state, { tool: 'nextcloud_talk_create_room' }, { success: true, room: { token: 'room1abc' } });
    notePublicValues(state, { tool: 'nextcloud_talk_list_rooms' }, { rooms: [{ token: 'room2abc' }, { token: 'room3abc' }] });
    notePublicValues(state, { tool: 'nextcloud_talk_list_participants' }, { token: 'room4abc', participants: [] });
    assert.deepEqual(publicValuesFor(state).sort(), ['room1abc', 'room2abc', 'room3abc', 'room4abc']);
});

test('outputs of any other tool contribute nothing', () => {
    const state = {};
    notePublicValues(state, { tool: 'http_request' }, { token: 'looks-like-a-secret' });
    notePublicValues(state, { tool: 'nextcloud_list_shares' }, { shares: [{ token: 'share-capability' }] });
    notePublicValues(state, { type: 'set' }, { token: 'set-output' });
    assert.deepEqual(publicValuesFor(state), []);
    assert.equal(state[PUBLIC_VALUES], undefined);
});

test('only the token key is collected, and only strings', () => {
    const state = {};
    notePublicValues(state, { tool: 'nextcloud_talk_get_room' }, { token: 'room1abc', password: 'pw-1234', access_token: 'at-1234', count: 3, nested: { token: 42 } });
    assert.deepEqual(publicValuesFor(state), ['room1abc']);
});

test('a layer sub-state shares the same Set and mask array as its parent', () => {
    const { sharedRunMarkers } = require('./publicValues');
    const { MASK_VALUES } = require('./httpAuth');
    const parent = { [MASK_VALUES]: ['m'], [PUBLIC_VALUES]: new Set() };
    const sub = { ...sharedRunMarkers(parent) };
    notePublicValues(sub, { tool: 'nextcloud_talk_create_room' }, { token: 'room1abc' });
    assert.deepEqual(publicValuesFor(parent), ['room1abc']);
    assert.equal(sub[MASK_VALUES], parent[MASK_VALUES]);
});

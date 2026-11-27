'use strict';
/**
 * The meeting-tag source kind reads the meetings of the meetingNotes module
 * (stores/transcriptionStore), so the engine lists it only while that module is here
 * (core/kb/sources/moduleKinds.js). This half of meetingTag.test.js is that module's.
 *
 * Run: cd server && node --test core/kb/sources/meetingTag.meetingNotes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

test('it is registered, or the engine stands down on every refresh', async () => {
    const { supportedKinds } = require('./index');
    assert.ok(supportedKinds().includes('meeting_tag'));
});

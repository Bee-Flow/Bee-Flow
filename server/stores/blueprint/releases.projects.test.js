/**
 * The boundary stores/blueprintStore.js shares with projects/packaging/releaseNotes.js (module
 * "projects"). Moved out of releases.test.js unchanged: it needs the module's file.
 *
 * Run: cd server && node --test stores/blueprint/releases.projects.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MAX_NOTES_BYTES } = require('../blueprintStore');

// ── 4. De grens die twee bestanden delen ────────────────────────────────────

test('de enveloppegrens van releaseNotes.js is dezelfde als MAX_NOTES_BYTES', async () => {
    // `releaseNotesPayload` shrinks to ITS OWN boundary, and that was copied by hand
    // because the store opens a pool on require. If
    // MAX_NOTES_BYTES ever drops below that copy, then `normalizeNotes` throws before the
    // transaction and a PUBLICATION is refused on account of a note — exactly
    // what releaseNotes.js promises can never happen. This test is the link that
    // fits in neither of the two files.
    const notes = require('../../projects/packaging/releaseNotes');
    assert.strictEqual(notes.MAX_NOTES_ENVELOPE_BYTES, MAX_NOTES_BYTES);

    // En de envelop die hij bij die grens teruggeeft, past er ook echt in.
    const rows = Array.from({ length: 400 }, (_, i) => ({
        kind: 'automation', entityId: `a${i}`, name: 'R'.repeat(100), change: 'changed', text: 'T'.repeat(150),
    }));
    const payload = notes.releaseNotesPayload(rows);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_NOTES_BYTES);
});

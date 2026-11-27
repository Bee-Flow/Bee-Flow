'use strict';

/**
 * A notebook's meeting source, as module "meetingNotes" reads it back (core/meetingNotes/meetingUsage).
 * Moved out of notebookStore.project.pg.test.js unchanged: it needs the module's file. That
 * addSource stores the meeting id in notebook_sources.source_ref_id is the core's half, pinned in
 * notebookStore.project.pg.test.js.
 *
 * Run: cd server && node --test stores/notebookStore.project.meetingNotes.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./notebookStore');

before(async () => {
    await store.initDB();
});

after(close);

test('a meeting source records which meeting it came from, so the meeting can name the notebook', async () => {
    const { usageForMeeting } = require('../core/meetingNotes/meetingUsage');
    const nb = await store.createNotebook({ userId: 'alice', name: 'Meeting digest' });
    await store.addSource({ notebookId: nb.id, type: 'meeting', name: 'Meeting Note: Kick-off', sourceRefId: 'meet-1', contentText: 'x', wordCount: 1 });

    const db = { query: (sql, params) => pg.query(sql, params) };
    const { rows, partial } = await usageForMeeting({ id: 'meet-1', tags: [], ownerId: 'alice' }, { db });
    assert.ok(!partial.includes('notebook'), `notebooks were checked (partial: ${partial})`);
    assert.ok(rows.some(r => r.kind === 'notebook' && r.id === nb.id), 'the notebook that holds the meeting is named');
});

// @typecheck
'use strict';

/**
 * Google Drive file.new poller, driven through a fake ctx and a fake Drive client.
 *
 * Run: node --test automation/triggerBus/pollers/googleDrive.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createGoogleDrivePollers } = require('./googleDrive');

function driveCtx(drive) {
    const updates = [];
    const ctx = {
        store: () => ({ updateSubscription: async (id, u) => { updates.push({ id, ...u }); } }),
        googleClient: () => ({ createGoogleApiClient: async () => drive }),
    };
    return { ctx, updates };
}

test('file.new bootstrap anchors at the start page token and delivers nothing', async () => {
    const { ctx, updates } = driveCtx({ changes: { getStartPageToken: async () => ({ data: { startPageToken: '77' } }) } });
    const out = await createGoogleDrivePollers(ctx)['file.new']({ id: 'd1', lastCursor: null }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 'd1', lastCursor: '77' }]);
});

test('file.new emits recently created files only and advances the page token', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    const changes = [
        { time: now, file: { id: 'f-new', name: 'new.pdf', createdTime: now } },
        { time: now, file: { id: 'f-old', name: 'old.pdf', createdTime: old } },
        { time: now, removed: true, file: { id: 'f-removed', createdTime: now } },
        { time: now, file: { id: 'f-trashed', createdTime: now, trashed: true } },
    ];
    const { ctx, updates } = driveCtx({ changes: { list: async () => ({ data: { changes, newStartPageToken: '78' } }) } });
    const out = await createGoogleDrivePollers(ctx)['file.new']({ id: 'd2', lastCursor: '77' }, {});
    assert.deepStrictEqual(out.map(e => e.fileId), ['f-new']);
    assert.deepStrictEqual(updates, [{ id: 'd2', lastCursor: JSON.stringify({ p: '78', fired: { 'f-new': Date.parse(now) } }) }]);
});

test('file.new with a stale cursor (404) clears it', async () => {
    const { ctx, updates } = driveCtx({ changes: { list: async () => { throw Object.assign(new Error('not found'), { code: 404 }); } } });
    assert.deepStrictEqual(await createGoogleDrivePollers(ctx)['file.new']({ id: 'd3', lastCursor: '1' }, {}), []);
    assert.deepStrictEqual(updates, [{ id: 'd3', lastCursor: null }]);
});

test('file.new fires once per file: an edit within 24 h of the creation is not a new file', async () => {
    const created = new Date(Date.now() - 60 * 60_000).toISOString();
    const change = (id) => ({ time: new Date().toISOString(), file: { id, name: `${id}.pdf`, createdTime: created } });
    const pages = [
        { changes: [change('f1'), change('f1')], newStartPageToken: '2' },
        { changes: [change('f1'), change('f2')], newStartPageToken: '3' },
        { changes: [change('f2'), change('f1')], newStartPageToken: '4' },
    ];
    const asked = [];
    const { ctx, updates } = driveCtx({ changes: { list: async ({ pageToken }) => { asked.push(pageToken); return { data: pages.shift() }; } } });
    const poll = createGoogleDrivePollers(ctx)['file.new'];
    const sub = { id: 'd4', lastCursor: '1' };
    const fired = [];
    for (let tick = 0; tick < 3; tick++) {
        fired.push((await poll(sub, {})).map(e => e.fileId));
        sub.lastCursor = updates[updates.length - 1].lastCursor;
    }
    assert.deepStrictEqual(fired, [['f1'], ['f2'], []]);
    assert.deepStrictEqual(asked, ['1', '2', '3'], 'the page token inside the cursor is what Drive is asked for');
});

test('file.new forgets a fired file once its 24 h window has closed, so the cursor stays small', async () => {
    const longAgo = Date.now() - 3 * 24 * 60 * 60_000;
    const { ctx, updates } = driveCtx({ changes: { list: async () => ({ data: { changes: [], newStartPageToken: '9' } }) } });
    await createGoogleDrivePollers(ctx)['file.new']({ id: 'd5', lastCursor: JSON.stringify({ p: '8', fired: { 'f-old': longAgo } }) }, {});
    assert.deepStrictEqual(updates, [{ id: 'd5', lastCursor: '9' }]);
});

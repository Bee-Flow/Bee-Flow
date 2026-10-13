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
    assert.deepStrictEqual(updates, [{ id: 'd2', lastCursor: '78' }]);
});

test('file.new with a stale cursor (404) clears it', async () => {
    const { ctx, updates } = driveCtx({ changes: { list: async () => { throw Object.assign(new Error('not found'), { code: 404 }); } } });
    assert.deepStrictEqual(await createGoogleDrivePollers(ctx)['file.new']({ id: 'd3', lastCursor: '1' }, {}), []);
    assert.deepStrictEqual(updates, [{ id: 'd3', lastCursor: null }]);
});

'use strict';

/**
 * Regression: the Nextcloud file.new trigger must fire when a file APPEARS in
 * the watched folder — including files MOVED / COPIED / RENAMED in, not just
 * fresh uploads. Nextcloud reports a move as `file_changed` (+ "moved … to"
 * subject), so the file.new detector reads the subject for arrivals while
 * leaving plain in-place edits to file.changed only.
 * (Moved here from ../../triggerBus.ncfilenew.test.js when triggerBus.js was split.)
 *
 * Run: node --test automation/triggerBus/pollers/nextcloud.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const { _ncNormaliseActivity } = require('./nextcloud');

const norm = (row) => _ncNormaliseActivity(row, {});

test('fresh upload (file_created) → file.new', () => {
    const p = norm({ id: 1, type: 'file_created', subject: 'You created Invoice.pdf', object_name: '/Invoices/test/Invoice.pdf', objectName: '/Invoices/test/Invoice.pdf' });
    assert.strictEqual(p._isFileCreated, true);
});

test('file MOVED into the folder (file_changed, "moved … to") → file.new', () => {
    const p = norm({ id: 2, type: 'file_changed', subject: 'You moved Invoices/Factuur_255066638.pdf to Invoices/test', objectName: '/Invoices/test/Factuur_255066638.pdf' });
    assert.strictEqual(p._isFileCreated, true, 'a moved-in file is a new arrival → file.new');
});

test('Dutch move subject ("verplaatst") → file.new', () => {
    const p = norm({ id: 3, type: 'file_changed', subject: 'Je hebt Factuur.pdf verplaatst naar Invoices/test', objectName: '/Invoices/test/Factuur.pdf' });
    assert.strictEqual(p._isFileCreated, true);
});

test('copied / restored / renamed → file.new', () => {
    assert.strictEqual(norm({ id: 4, type: 'file_changed', subject: 'You copied X.pdf', objectName: '/Invoices/test/X.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 5, type: 'file_restored', subject: 'You restored X.pdf', objectName: '/Invoices/test/X.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 6, type: 'file_changed', subject: 'You renamed A.pdf to B.pdf', objectName: '/Invoices/test/B.pdf' })._isFileCreated, true);
});

test('plain in-place EDIT (file_changed, "changed") is NOT file.new', () => {
    const p = norm({ id: 7, type: 'file_changed', subject: 'You changed Invoice.pdf', objectName: '/Invoices/test/Invoice.pdf' });
    assert.strictEqual(p._isFileCreated, false, 'an edit must stay file.changed only');
    assert.strictEqual(p._isFileChanged, true);
});

test('path + name + extension are normalised from objectName', () => {
    const p = norm({ id: 8, type: 'file_created', subject: 'created', objectName: '/Invoices/test/Factuur.pdf' });
    assert.strictEqual(p.path, '/Invoices/test/Factuur.pdf');
    assert.strictEqual(p.name, 'Factuur.pdf');
    assert.strictEqual(p.extension, 'pdf');
});


// ── Pollers, driven through a fake ctx (no Nextcloud, no DB) ────────────

const { createNextcloudPollers } = require('./nextcloud');

function ncCtx({ activities = [], notifications = [], events = [] } = {}) {
    const updates = [];
    const ctx = {
        store: () => ({ updateSubscription: async (id, u) => { updates.push({ id, ...u }); } }),
        ncScopeGuard: () => ({ guardedNcCall: async (_name, _args, _c, run) => run() }),
        nextcloudActivityTools: () => ({ executeNextcloudActivityTool: async () => ({ activities: activities.slice() }) }),
        nextcloudNotificationsTools: () => ({ executeNextcloudNotificationsTool: async () => ({ notifications }) }),
        nextcloudCalendarTools: () => ({ executeNextcloudCalendarTool: async () => ({ events }) }),
    };
    return { ctx, updates };
}

test('activity channel: first poll only anchors the cursor at the newest activity id', async () => {
    const { ctx, updates } = ncCtx({ activities: [{ id: 5, type: 'file_created', objectName: '/a.pdf' }, { id: 9, type: 'file_created', objectName: '/b.pdf' }] });
    const out = await createNextcloudPollers(ctx)['file.new']({ id: 'sub-1', userId: 'nc-user-anchor', lastCursor: null }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 'sub-1', lastCursor: '9' }]);
});

test('activity channel: emits only fresh rows the predicate accepts and advances the cursor', async () => {
    const { ctx, updates } = ncCtx({
        activities: [
            { id: 3, type: 'file_created', subject: 'created', objectName: '/old.pdf' },
            { id: 4, type: 'file_changed', subject: 'You changed x.pdf', objectName: '/x.pdf' },
            { id: 6, type: 'file_created', subject: 'created', objectName: '/new.pdf' },
        ],
    });
    const out = await createNextcloudPollers(ctx)['file.new']({ id: 'sub-2', userId: 'nc-user-fresh', lastCursor: '3' }, {});
    assert.deepStrictEqual(out.map(e => e.activityId), [6], 'an in-place edit is not file.new; the old row is behind the cursor');
    assert.deepStrictEqual(updates, [{ id: 'sub-2', lastCursor: '6' }]);
});

test('notification.new: anchors on the first non-empty poll, then emits only newer ids', async () => {
    const first = ncCtx({ notifications: [{ id: 2 }, { id: 7 }] });
    assert.deepStrictEqual(await createNextcloudPollers(first.ctx)['notification.new']({ id: 'n1', userId: 'u', lastCursor: null }, {}), []);
    assert.deepStrictEqual(first.updates, [{ id: 'n1', lastCursor: '7' }]);

    const next = ncCtx({ notifications: [{ id: 7, subject: 'old' }, { id: 8, app: 'files', subject: 'new' }] });
    const out = await createNextcloudPollers(next.ctx)['notification.new']({ id: 'n1', userId: 'u', lastCursor: '7' }, {});
    assert.deepStrictEqual(out.map(n => n.notificationId), [8]);
    assert.deepStrictEqual(next.updates, [{ id: 'n1', lastCursor: '8' }]);
});

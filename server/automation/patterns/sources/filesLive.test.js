'use strict';

/**
 * Live files with a fake executeTool.
 *
 * Run: cd server && node --test automation/patterns/sources/filesLive.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { collectNextcloudFiles, collectOneDrive, collectGoogleDrive, classifyActivity, splitPath } = require('./filesLive');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18, 0);
const SINCE = NOW - 90 * DAY;
const iso = (d) => new Date(NOW - d * DAY).toISOString();

/** Answers each tool with a fixed value and keeps the calls. */
const fakeExec = (answers, calls = []) => ({ calls, exec: async (name, args) => (calls.push({ name, args }), answers[name]) });
const ctxWith = (exec, extra = {}) => ({ now: NOW, since: SINCE, windowDays: 90, executeTool: exec, pseudoDomain: () => 'd1', ...extra });

test('nextcloud: own file actions only, folders and deletes dropped, paths gone', async () => {
    const { exec, calls } = fakeExec({
        nextcloud_activity_list: {
            activities: [
                { type: 'file_created', subject: 'You created Sales report 41.xlsx', actor: 'me', objectType: 'files', objectName: '/Reports/Sales report 41.xlsx', datetime: iso(2) },
                { type: 'file_created', subject: 'You created Sales report 40.xlsx', actor: 'me', objectType: 'files', objectName: '/Reports/Sales report 40.xlsx', datetime: iso(9) },
                { type: 'file_changed', subject: 'You moved Offer Jansen.docx', actor: 'me', objectType: 'files', objectName: '/Offers/Offer Jansen.docx', datetime: iso(3) },
                { type: 'file_changed', subject: 'You changed Notes.md', actor: 'me', objectType: 'files', objectName: '/Notes.md', datetime: iso(1) },
                { type: 'file_deleted', subject: 'You deleted a.txt', actor: 'me', objectType: 'files', objectName: '/a.txt', datetime: iso(1) },
                { type: 'file_created', subject: 'You created Reports', actor: 'me', objectType: 'files', objectName: '/Reports', datetime: iso(1) },
                { type: 'calendar_event', subject: 'You created an event', actor: 'me', objectType: 'calendar', objectName: 'x', datetime: iso(1) },
                { type: 'file_created', subject: 'Someone created b.txt', actor: 'other', objectType: 'files', objectName: '/Shared/b.txt', datetime: iso(1) },
                { type: 'file_created', subject: 'You created old.txt', actor: 'me', objectType: 'files', objectName: '/old.txt', datetime: iso(120) },
            ],
        },
    });
    const events = await collectNextcloudFiles(ctxWith(exec, { nextcloudUid: 'me' }));
    assert.deepStrictEqual(calls, [{ name: 'nextcloud_activity_list', args: { filter: 'self', limit: 200 } }]);
    assert.deepStrictEqual(events.map((e) => [e.verb, e.template]), [
        ['file.created', 'Sales report <n>'],
        ['file.created', 'Sales report <n>'],
        ['file.created', 'Offer Jansen'],
        ['file.changed', 'Notes'],
    ]);
    assert.ok(events.every((e) => e.source === 'files' && e.objectType === 'file' && e.app === 'nextcloud'));
    assert.strictEqual(events[0].sessionKey, events[1].sessionKey, 'same folder, same key');
    assert.notStrictEqual(events[0].sessionKey, events[2].sessionKey);
    const text = JSON.stringify(events);
    assert.ok(!text.includes('/Reports') && !text.includes('You ') && !text.includes('"me"'));
});

test('onedrive: created in the window → created, older → changed', async () => {
    const { exec, calls } = fakeExec({
        onedrive_list_recent: {
            items: [
                { id: 'i1', name: 'Invoice 2026-10.pdf', parentId: 'P1', parentPath: '/Finance', created: iso(5), lastModified: iso(5) },
                { id: 'i2', name: 'Budget.xlsx', parentId: 'P1', created: iso(400), lastModified: iso(2) },
                { id: 'i3', name: '', parentId: 'P1', created: iso(1), lastModified: iso(1) },
            ],
        },
    });
    const events = await collectOneDrive(ctxWith(exec));
    assert.deepStrictEqual(calls[0].args, { since: iso(90), maxResults: 200 });
    assert.deepStrictEqual(events.map((e) => [e.verb, e.template, e.ts]), [
        ['file.created', 'Invoice <date> <n>', Date.parse(iso(5))],
        ['file.changed', 'Budget', Date.parse(iso(2))],
    ]);
    assert.ok(!JSON.stringify(events).includes('P1'));
});

test('onedrive: a file a colleague changed last is their work and is left out', async () => {
    const { exec } = fakeExec({
        onedrive_list_recent: {
            items: [
                { id: 'i1', name: 'Mine.xlsx', parentId: 'P1', created: iso(400), lastModified: iso(3), modifiedByMe: true },
                { id: 'i2', name: 'Theirs.xlsx', parentId: 'P1', created: iso(400), lastModified: iso(2), modifiedByMe: false },
                { id: 'i3', name: 'Unknown.xlsx', parentId: 'P1', created: iso(400), lastModified: iso(1) },
            ],
        },
    });
    const events = await collectOneDrive(ctxWith(exec));
    assert.deepStrictEqual(events.map((e) => e.template), ['Mine', 'Unknown']);
});

test('google drive: only the user\'s own edits; a file someone else owns is never "created"', async () => {
    const { exec } = fakeExec({
        drive_list_recent: {
            results: [
                { id: 'f1', name: 'Minutes 2026-09-28.docx', parentId: 'D1', createdTime: iso(5), modifiedTime: iso(5), ownedByMe: true, modifiedByMe: true },
                { id: 'f2', name: 'Shared plan.docx', parentId: 'D2', createdTime: iso(5), modifiedTime: iso(4), ownedByMe: false, modifiedByMe: true },
                { id: 'f3', name: 'Their file.docx', parentId: 'D2', createdTime: iso(5), modifiedTime: iso(4), ownedByMe: false, modifiedByMe: false },
            ],
        },
    });
    const events = await collectGoogleDrive(ctxWith(exec));
    assert.deepStrictEqual(events.map((e) => [e.app, e.verb, e.template]), [
        ['google_drive', 'file.created', 'Minutes <date>'],
        ['google_drive', 'file.changed', 'Shared plan'],
    ]);
});

test('a connector error stops the source with a code', async () => {
    const { exec } = fakeExec({ drive_list_recent: { error: 'Not connected to Google Drive' } });
    await assert.rejects(collectGoogleDrive(ctxWith(exec)), (err) => err.code === 'auth');
    const { exec: thrower } = { exec: async () => { throw new Error('boom'); } };
    await assert.rejects(collectOneDrive(ctxWith(thrower)), /boom/);
});

test('classifyActivity and splitPath', () => {
    assert.strictEqual(classifyActivity('file_restored', ''), 'file.created');
    assert.strictEqual(classifyActivity('file_changed', 'Je hebt x verplaatst'), 'file.created');
    assert.strictEqual(classifyActivity('file_changed', 'You changed x'), 'file.changed');
    assert.strictEqual(classifyActivity('files', 'You created x'), 'file.created');
    assert.strictEqual(classifyActivity('file_deleted', 'You deleted x'), null);
    assert.deepStrictEqual(splitPath('/A/B/c.pdf'), { name: 'c.pdf', folder: '/A/B' });
    assert.deepStrictEqual(splitPath('top.pdf'), { name: 'top.pdf', folder: '/' });
    assert.strictEqual(splitPath('/A/B/'), null);
    assert.strictEqual(splitPath('/A/Folder'), null);
});

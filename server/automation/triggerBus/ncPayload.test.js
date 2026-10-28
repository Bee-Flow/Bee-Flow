// @typecheck
'use strict';

/**
 * #193: one canonical payload per Nextcloud event, whichever producer saw it.
 * The same file event, once as the connector's webhook delivers it and once as
 * the activity poller reads it, must reach a filter with the same keys, and the
 * catalog must declare exactly those keys.
 *
 * The webhook fixtures are the output of nextcloud-connector's
 * automationEventsWebhook.normalisePayload (copied, not required: the server's
 * tests do not install the connector's dependencies).
 *
 * Run: node --test automation/triggerBus/ncPayload.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { FILE_FIELDS, normaliseFilePayload, normaliseNextcloudPayload, normaliseCalendarPayload, guessKind } = require('./ncPayload.mts');
const { _ncNormaliseActivity } = require('./pollers/nextcloud');
const { FILE_EVENTS } = require('../triggerSources/nextcloudFileEvents');

// automationEventsWebhook.normalisePayload('file.new', { event: { node: { id: 437, path: '/alice/files/Invoices/x.pdf' } }, user: { uid: 'bob', displayName: 'Bob' }, time })
const WEBHOOK_FILE = {
    id: 437, path: '/Invoices/x.pdf', name: 'x.pdf', extension: 'pdf', kind: 'file', owner: 'alice',
    actor: 'bob', actorName: 'Bob', datetime: '2026-10-28T09:00:00.000Z', link: null,
};
// The activity row the poller reads for the same upload, in alice's feed.
const ACTIVITY_ROW = {
    id: 9001, type: 'file_created', subject: 'Bob created x.pdf', message: '', actor: 'bob',
    objectType: 'files', objectId: 437, objectName: '/Invoices/x.pdf', link: 'https://cloud.example.com/f/437', datetime: '2026-10-28T09:00:00+00:00',
};

test('webhook and poller deliver the same canonical keys for a file event', () => {
    const fromWebhook = normaliseNextcloudPayload('file.new', WEBHOOK_FILE);
    const fromPoller = normaliseNextcloudPayload('file.new', _ncNormaliseActivity(ACTIVITY_ROW, { nextcloudUid: 'alice' }));
    for (const key of FILE_FIELDS) {
        assert.ok(key in fromWebhook, `webhook payload has ${key}`);
        assert.ok(key in fromPoller, `poller payload has ${key}`);
    }
    // The fields both producers know agree.
    for (const key of ['id', 'path', 'name', 'extension', 'kind', 'owner', 'actor']) {
        assert.deepStrictEqual(fromPoller[key], fromWebhook[key], key);
    }
    // What only one producer knows is null on the other, never missing.
    assert.strictEqual(fromWebhook.activityId, null);
    assert.strictEqual(fromPoller.activityId, 9001);
    assert.strictEqual(fromPoller.actorName, null);
    assert.strictEqual(fromWebhook.link, null);
});

test('the catalog declares exactly the canonical keys for every file event', () => {
    for (const ev of FILE_EVENTS) {
        const expected = ev.id === 'file.renamed'
            ? [...FILE_FIELDS.slice(0, 3), 'oldPath', ...FILE_FIELDS.slice(3)]
            : [...FILE_FIELDS];
        assert.deepStrictEqual(ev.fields, expected, ev.id);
        assert.deepStrictEqual(Object.keys(ev.sample).sort(), [...expected].sort(), `${ev.id} sample`);
    }
});

test('old keys survive as they were: the poller keeps activityId / objectName / type, the webhook its oldPath', () => {
    const polled = _ncNormaliseActivity(ACTIVITY_ROW, {});
    assert.strictEqual(polled.activityId, 9001);
    assert.strictEqual(polled.objectName, '/Invoices/x.pdf');
    assert.strictEqual(polled.type, 'file_created');
    assert.strictEqual(polled.raw, ACTIVITY_ROW);
    const renamed = normaliseNextcloudPayload('file.renamed', { ...WEBHOOK_FILE, oldPath: '/Invoices/draft.pdf', sourceId: 437 });
    assert.strictEqual(renamed.oldPath, '/Invoices/draft.pdf');
    assert.strictEqual(renamed.sourceId, 437);
});

test('kind follows one rule for both producers (the webhook used to call everything a file)', () => {
    assert.strictEqual(normaliseFilePayload({ ...WEBHOOK_FILE, path: '/Invoices', name: 'Invoices', extension: null, kind: 'file' }).kind, 'folder');
    assert.strictEqual(_ncNormaliseActivity({ id: 1, type: 'file_created', objectName: '/Invoices' }, {}).kind, 'folder');
    assert.strictEqual(guessKind('/a/b.pdf', 'pdf'), 'file');
    assert.strictEqual(guessKind('/a/b/', null), 'folder');
});

test('the poller fills owner from the feed it reads and isOwnAction from the actor', () => {
    const own = _ncNormaliseActivity({ ...ACTIVITY_ROW, actor: 'alice' }, { nextcloudUid: 'alice' });
    assert.strictEqual(own.owner, 'alice');
    assert.strictEqual(own.isOwnAction, true);
    // A connector-bound session carries the uid as connectorNcUid.
    const viaConnector = _ncNormaliseActivity({ ...ACTIVITY_ROW, actor: 'alice' }, { connectorNcUid: 'alice' });
    assert.strictEqual(viaConnector.isOwnAction, true);
    assert.strictEqual(_ncNormaliseActivity(ACTIVITY_ROW, { nextcloudUid: 'alice' }).isOwnAction, false);
});

test('normalising twice changes nothing', () => {
    const once = normaliseNextcloudPayload('file.changed', WEBHOOK_FILE);
    assert.deepStrictEqual(normaliseNextcloudPayload('file.changed', once), once);
});

test('calendar payloads carry calendarId and calendarUri from either producer', () => {
    assert.deepStrictEqual(
        normaliseCalendarPayload({ calendarId: 'personal', uid: 'a' }),
        { calendarId: 'personal', calendarUri: 'personal', uid: 'a' },
    );
    const pushed = normaliseNextcloudPayload('calendar.event.created', { calendarId: 4, calendarUri: 'work' });
    assert.strictEqual(pushed.calendarId, 4);
    assert.strictEqual(pushed.calendarUri, 'work');
    // A numeric id alone is never mistaken for a URI.
    assert.strictEqual(normaliseCalendarPayload({ calendarId: '4' }).calendarUri, null);
});

test('other events pass through untouched', () => {
    const talk = { roomToken: 'r1', message: 'hi' };
    assert.strictEqual(normaliseNextcloudPayload('talk.message.received', talk), talk);
    assert.deepStrictEqual(normaliseNextcloudPayload('talk.message.received', null), {});
});

// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/events.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { makeEvent, makeEvents, isUserAction, SOURCES } = require('./events');

const base = { ts: Date.UTC(2026, 9, 1, 9), source: 'mail', app: 'gmail', verb: 'mail.received', objectType: 'mail' };

test('makeEvent copies only allow-listed fields', () => {
    const ev = makeEvent({
        ...base, template: 'Factuur <id>', direction: 'in', hasAttachment: true, bulk: false, domainPseudo: 'd1',
        subject: 'Factuur 123 van Pieter', body: 'secret', from: 'pieter@example.org', to: ['x@example.org'], path: '/home/p',
    });
    assert.deepStrictEqual(Object.keys(ev).sort(), [
        'app', 'bulk', 'direction', 'domainPseudo', 'hasAttachment', 'objectType', 'sessionKey', 'source', 'template', 'templateId', 'ts', 'verb',
    ]);
    assert.match(ev.templateId, /^[0-9a-f]{12}$/);
    assert.strictEqual(ev.sessionKey, null);
});

test('makeEvent masks a template that still holds an address or url', () => {
    const ev = makeEvent({ ...base, template: 'Hi pieter@example.org see https://x.example/a' });
    assert.strictEqual(ev.template, 'Hi <email> see <url>');
});

test('makeEvent rejects unknown sources, object types and bad timestamps', () => {
    assert.strictEqual(makeEvent({ ...base, source: 'chat' }), null);
    assert.strictEqual(makeEvent({ ...base, objectType: 'person' }), null);
    assert.strictEqual(makeEvent({ ...base, ts: 'not a date' }), null);
    assert.strictEqual(makeEvent({ ...base, app: 'has space' }), null);
    assert.strictEqual(makeEvent(null), null);
    assert.ok(makeEvent({ ...base, ts: '2026-10-01T09:00:00Z' }));
    assert.deepStrictEqual(SOURCES, ['ledger', 'meetings', 'documents', 'mail', 'files']);
});

test('makeEvent drops a domain that is not a pseudonym', () => {
    assert.strictEqual(makeEvent({ ...base, domainPseudo: 'example.org' }).domainPseudo, undefined);
    assert.strictEqual(makeEvent({ ...base, domainPseudo: 'd_3f9a' }).domainPseudo, 'd_3f9a');
});

test('makeEvents filters invalid rows', () => {
    assert.strictEqual(makeEvents([base, { ...base, source: 'nope' }, null]).length, 1);
});

test('isUserAction: tools, sent mail and created files count; received mail and meetings do not', () => {
    assert.strictEqual(isUserAction(makeEvent({ ...base, source: 'ledger', objectType: 'tool', verb: 'gmail_search' })), true);
    assert.strictEqual(isUserAction(makeEvent({ ...base, direction: 'out', verb: 'mail.sent' })), true);
    assert.strictEqual(isUserAction(makeEvent({ ...base, direction: 'in' })), false);
    assert.strictEqual(isUserAction(makeEvent({ ...base, source: 'files', objectType: 'file', verb: 'file.created' })), true);
    assert.strictEqual(isUserAction(makeEvent({ ...base, source: 'meetings', objectType: 'meeting', verb: 'meeting.held' })), false);
});

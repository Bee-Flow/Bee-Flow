'use strict';

/**
 * G-01: the six Nextcloud events the connector already delivers
 * (deliverableEvents.js WEBHOOK_BACKED) are declared, so the validator no
 * longer says an automation on one of them cannot fire.
 *
 * Run: cd server && node --test automation/validate.ncDeliveredEvents.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');

const mk = (ev) => ({ trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'nextcloud', event: ev } }, steps: [], edges: [] });

test('file.copied / restored / untagged, tables.row.deleted and calendar.event.moved / deleted draw no "cannot fire" warning', () => {
    for (const ev of ['file.copied', 'file.restored', 'file.untagged', 'tables.row.deleted', 'calendar.event.moved', 'calendar.event.deleted']) {
        const r = validateDefinition(mk(ev), { deliverableEvents: getDeliverableEvents() });
        const cannotFire = r.warnings.filter(w => w.code === 'trigger.app_event_unknown_event' || w.code === 'trigger.app_event_undeliverable');
        assert.deepEqual(cannotFire, [], `nextcloud.${ev} is declared and delivered`);
    }
});

test('an event nothing declares still draws the warning', () => {
    const r = validateDefinition(mk('file.teleported'), { deliverableEvents: getDeliverableEvents() });
    assert.ok(r.warnings.some(w => w.code === 'trigger.app_event_unknown_event'));
});

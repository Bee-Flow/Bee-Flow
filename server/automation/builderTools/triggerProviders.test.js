'use strict';

/**
 * Tests for the app_event provider registry + availability filter.
 * Pure data/function under test — no mocks needed.
 *
 * Run: node --test automation/builderTools/triggerProviders.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { TRIGGER_PROVIDERS, buildAppEventProviders, getProviderDef } = require('./triggerProviders');
const { TRIGGER_FIELDS_BY_EVENT, TRIGGER_OUTPUT_SAMPLES } = require('./triggerCatalog');
const { POLLER_BACKED, WEBHOOK_BACKED, BOT_BACKED, PUSH_PENDING } = require('../deliverableEvents');

const ctx = (over = {}) => ({ availableAppIds: new Set(), checks: {}, publicBaseUrl: false, ...over });
const ids = (providers) => providers.map(p => p.id);

test('consistency join: every listed provider.event has catalog fields AND an output sample', () => {
    for (const p of TRIGGER_PROVIDERS) {
        if (p.hidden) continue;
        assert.ok(p.events.length > 0, `${p.id} lists at least one event`);
        for (const ev of p.events) {
            const key = `${p.id}.${ev.id}`;
            assert.ok(Array.isArray(TRIGGER_FIELDS_BY_EVENT[key]), `${key} missing in TRIGGER_FIELDS_BY_EVENT`);
            assert.ok(TRIGGER_OUTPUT_SAMPLES[key] && typeof TRIGGER_OUTPUT_SAMPLES[key] === 'object',
                `${key} missing in TRIGGER_OUTPUT_SAMPLES`);
            assert.ok(ev.label && typeof ev.label === 'string', `${key} has a label`);
        }
        assert.ok(p.events.some(ev => ev.id === p.defaultEvent),
            `${p.id} defaultEvent '${p.defaultEvent}' is one of its listed events`);
    }
});

test('tools-gated providers appear iff their app id is available', () => {
    assert.deepStrictEqual(ids(buildAppEventProviders(ctx())), []);
    assert.deepStrictEqual(
        ids(buildAppEventProviders(ctx({ availableAppIds: new Set(['gmail']) }))),
        ['gmail']);
    assert.deepStrictEqual(
        ids(buildAppEventProviders(ctx({ availableAppIds: new Set(['gmail', 'google-calendar', 'google-drive']) }))),
        ['gmail', 'google-calendar', 'google-drive']);
    // Unrelated apps don't leak providers.
    assert.deepStrictEqual(
        ids(buildAppEventProviders(ctx({ availableAppIds: new Set(['youtrack', 'maps']) }))),
        []);
});

test('nextcloud matches by app-id prefix (any nextcloud-* tool app)', () => {
    for (const appId of ['nextcloud', 'nextcloud-deck', 'nextcloud-calendar']) {
        assert.deepStrictEqual(
            ids(buildAppEventProviders(ctx({ availableAppIds: new Set([appId]) }))),
            ['nextcloud'], `app '${appId}' should expose the nextcloud provider`);
    }
});

test('connection-backed checks gate support', () => {
    assert.deepStrictEqual(ids(buildAppEventProviders(ctx({ checks: {} }))), []);
    assert.deepStrictEqual(
        ids(buildAppEventProviders(ctx({ checks: { support: true } }))),
        ['support']);
    // Truthiness is not enough — must be exactly true (fail closed).
    assert.deepStrictEqual(
        ids(buildAppEventProviders(ctx({ checks: { support: 'yes' } }))),
        []);
});

test('msgraph requires an available MS app AND a public base URL', () => {
    const msApps = new Set(['outlook']);
    assert.deepStrictEqual(ids(buildAppEventProviders(ctx({ availableAppIds: msApps }))), []);
    assert.deepStrictEqual(ids(buildAppEventProviders(ctx({ publicBaseUrl: true }))), []);
    assert.deepStrictEqual(
        ids(buildAppEventProviders(ctx({ availableAppIds: msApps, publicBaseUrl: true }))),
        ['msgraph']);
    // Any of the four MS app ids suffices.
    for (const appId of ['outlook', 'ms-calendar', 'onedrive', 'outlook-readonly']) {
        assert.deepStrictEqual(
            ids(buildAppEventProviders(ctx({ availableAppIds: new Set([appId]), publicBaseUrl: true }))),
            ['msgraph']);
    }
    // msgraph never lists the runtime-only 'event.updated' alias.
    const [msgraph] = buildAppEventProviders(ctx({ availableAppIds: msApps, publicBaseUrl: true }));
    assert.ok(!msgraph.events.some(ev => ev.id === 'event.updated'));
});

test('github is never returned, even with everything enabled, but stays label-resolvable', () => {
    const everything = ctx({
        availableAppIds: new Set(['gmail', 'github', 'nextcloud', 'outlook']),
        checks: { support: true },
        publicBaseUrl: true,
    });
    assert.ok(!ids(buildAppEventProviders(everything)).includes('github'));
    assert.strictEqual(getProviderDef('github').label, 'GitHub');
    assert.strictEqual(getProviderDef('github').hidden, true);
    assert.strictEqual(getProviderDef('nope'), null);
});

test('per-event deliverability mirrors deliverableEvents (producer ok, no producer flagged)', () => {
    const [nc] = buildAppEventProviders(ctx({ availableAppIds: new Set(['nextcloud']) }));
    assert.strictEqual(nc.id, 'nextcloud');
    for (const ev of nc.events) {
        if (PUSH_PENDING.nextcloud.has(ev.id)) {
            // No producer at all — Nextcloud exposes no webhook-compatible
            // event class for Share/Deck/Talk and we have no poller.
            assert.strictEqual(ev.deliverability, 'connector', `${ev.id} has no producer`);
        } else {
            assert.ok(
                POLLER_BACKED.nextcloud.has(ev.id)
                || WEBHOOK_BACKED.nextcloud.has(ev.id)
                || BOT_BACKED.nextcloud.has(ev.id),
                `${ev.id} must be poller-, webhook- or bot-backed, or flagged as having no producer`,
            );
            assert.strictEqual(ev.deliverability, 'ok', `${ev.id} has a producer`);
        }
    }
    // Non-nextcloud providers are all 'ok'.
    const [gmail] = buildAppEventProviders(ctx({ availableAppIds: new Set(['gmail']) }));
    assert.ok(gmail.events.every(ev => ev.deliverability === 'ok'));
});

test('catalog-ready shape: id/label/defaultEvent + events[{id,label,deliverability}] only', () => {
    const [gmail] = buildAppEventProviders(ctx({ availableAppIds: new Set(['gmail']) }));
    assert.deepStrictEqual(Object.keys(gmail).sort(), ['defaultEvent', 'events', 'id', 'label']);
    for (const ev of gmail.events) {
        assert.deepStrictEqual(Object.keys(ev).sort(), ['deliverability', 'id', 'label']);
    }
    // No availability/hidden internals leak into the response shape.
    assert.strictEqual(gmail.availability, undefined);
});

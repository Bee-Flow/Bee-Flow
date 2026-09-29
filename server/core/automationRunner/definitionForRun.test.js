/**
 * definitionForRun — which copy a run executes (handoff 5 live split).
 *
 * Run: cd server && node --test core/automationRunner/definitionForRun.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { definitionForRun, automationForRun, isTestRun, liveHasTrigger, SETTINGS_KEYS } = require('./definitionForRun');
const { rowToAutomation } = require('../../stores/automationStore/rowMappers');

const WORKING = { trigger: { id: 't1', kind: 'manual' }, triggers: [{ id: 'hook2', kind: 'webhook' }], steps: [{ id: 'new' }] };
const LIVE = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 'old' }] };

/** A row the way the store hands it out: live copy non-enumerable. */
function liveRow(overrides = {}) {
    return rowToAutomation({
        id: 'a1', user_id: 'u1', title: 'R', kind: 'automation',
        definition_json: WORKING, version: 7,
        live_definition_json: LIVE, live_version: 5, live_at: new Date().toISOString(),
        ...overrides,
    });
}

test('scheduled, event, webhook, form, app and agent runs execute the LIVE copy', () => {
    for (const triggerKind of ['schedule', 'app_event', 'webhook', 'form', 'studio_app', 'agent_call', 'manual']) {
        const got = definitionForRun(liveRow(), { mode: 'live', triggerKind });
        assert.strictEqual(got.source, 'live', triggerKind);
        assert.deepStrictEqual(got.definition.steps, [{ id: 'old' }]);
        assert.strictEqual(got.version, 5);
    }
});

test('test runs execute the WORKING copy: dry run, partial builder run, Test button', () => {
    for (const opts of [{ mode: 'dry_run' }, { mode: 'live', triggerKind: 'manual_step' }, { mode: 'live', triggerKind: 'manual', isTest: true }]) {
        const got = definitionForRun(liveRow(), opts);
        assert.strictEqual(got.source, 'working', JSON.stringify(opts));
        assert.strictEqual(got.version, 7);
        assert.deepStrictEqual(got.definition.steps, [{ id: 'new' }]);
    }
    assert.strictEqual(isTestRun({ mode: 'live', triggerKind: 'schedule' }), false);
});

test('a never-live routine runs its working copy (behaviour unchanged)', () => {
    const row = liveRow({ live_definition_json: null, live_version: null, live_at: null });
    const got = definitionForRun(row, { mode: 'live', triggerKind: 'schedule' });
    assert.strictEqual(got.source, 'working');
    assert.strictEqual(automationForRun(row, { mode: 'live' }), row, 'same object when nothing changes');
});

test('a Reusable Step is never swapped (it has its own published version)', () => {
    const row = liveRow({ kind: 'block' });
    assert.strictEqual(definitionForRun(row, { mode: 'live' }).source, 'working');
});

test('a synthetic automation spread from a row keeps the definition its caller chose', () => {
    const synthetic = { ...liveRow(), definition: { trigger: { id: 't1' }, steps: [{ id: 'partial' }] } };
    // The spread dropped the non-enumerable live copy: nothing to swap to.
    const got = definitionForRun(synthetic, { mode: 'live', triggerKind: 'manual' });
    assert.strictEqual(got.source, 'working');
    assert.deepStrictEqual(got.definition.steps, [{ id: 'partial' }]);
});

test('automationForRun swaps definition + version and records the working version', () => {
    const a = automationForRun(liveRow(), { mode: 'live', triggerKind: 'schedule' });
    assert.strictEqual(a.version, 5, 'the run row records the LIVE version');
    assert.strictEqual(a.workingVersion, 7);
    assert.deepStrictEqual(a.definition.steps, [{ id: 'old' }]);
    // Idempotent: selecting again on the result changes nothing.
    assert.strictEqual(automationForRun(a, { mode: 'live' }), a);
});

test('liveHasTrigger: a trigger that exists only in the working copy is not live yet', () => {
    const row = liveRow();
    assert.strictEqual(liveHasTrigger(row, 't1'), true);
    assert.strictEqual(liveHasTrigger(row, null), true, 'no id = the primary');
    assert.strictEqual(liveHasTrigger(row, 'hook2'), false);
});

test('null in, null out', () => {
    assert.strictEqual(automationForRun(null, { mode: 'live' }), null);
    assert.strictEqual(definitionForRun(null).source, 'working');
});

test('settings apply immediately: a live run reads notificationSettings and runPolicy from the WORKING copy', () => {
    assert.deepStrictEqual([...SETTINGS_KEYS], ['notificationSettings', 'runPolicy']);
    const row = liveRow({
        definition_json: {
            ...WORKING,
            notificationSettings: { onFailure: { enabled: true } },
            runPolicy: { retry: { max: 3 } },
        },
        live_definition_json: {
            ...LIVE,
            notificationSettings: { onFailure: { enabled: false } },
            runPolicy: { retry: { max: 0 } },
        },
    });
    const got = definitionForRun(row, { mode: 'live', triggerKind: 'schedule' });
    assert.strictEqual(got.source, 'live');
    assert.deepStrictEqual(got.definition.steps, [{ id: 'old' }], 'the steps stay live');
    assert.deepStrictEqual(got.definition.notificationSettings, { onFailure: { enabled: true } });
    assert.deepStrictEqual(got.definition.runPolicy, { retry: { max: 3 } });
    const a = automationForRun(row, { mode: 'live' });
    assert.deepStrictEqual(a.definition.runPolicy, { retry: { max: 3 } }, 'automationForRun carries the overlay');
    assert.deepStrictEqual(a.definition.steps, [{ id: 'old' }]);
});

test('a setting removed from the working copy is gone from the live run too; the stored live copy is not mutated', () => {
    const liveDef = { ...LIVE, runPolicy: { retry: { max: 2 } } };
    const row = liveRow({ definition_json: { ...WORKING }, live_definition_json: liveDef });
    const got = definitionForRun(row, { mode: 'live' });
    assert.strictEqual('runPolicy' in got.definition, false);
    assert.deepStrictEqual(row.liveDefinition.runPolicy, { retry: { max: 2 } }, 'overlay is a copy');
});

test('equal settings hand back the live object itself', () => {
    const row = liveRow();
    assert.strictEqual(definitionForRun(row, { mode: 'live' }).definition, row.liveDefinition);
});

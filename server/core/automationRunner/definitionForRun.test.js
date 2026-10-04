/**
 * definitionForRun — which copy a run executes (handoff 5 live split).
 *
 * Run: cd server && node --test core/automationRunner/definitionForRun.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { definitionForRun, automationForRun, isTestRun, liveHasTrigger, SETTINGS_KEYS, withWorkingSettings } = require('./definitionForRun');
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

test('a never-live automation runs its working copy (behaviour unchanged)', () => {
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

// ── Managed automations (D17): an automation in a Solution stage project ───────────

function managedRow(overrides = {}) {
    return liveRow({
        definition_json: {
            ...WORKING,
            notificationSettings: { onFailure: { enabled: true, recipients: ['incoming'] } },
            runPolicy: { retry: { max: 9 } },
        },
        live_definition_json: {
            ...LIVE,
            notificationSettings: { onFailure: { enabled: false } },
            runPolicy: { retry: { max: 1 } },
        },
        ...overrides,
    });
}

test('managed live runs use the LIVE settings, while unmanaged runs still overlay the working settings', () => {
    const row = managedRow();
    const managed = definitionForRun(row, { mode: 'live', triggerKind: 'schedule', managed: true });
    assert.strictEqual(managed.source, 'live');
    assert.strictEqual(managed.version, 5);
    assert.deepStrictEqual(managed.definition.steps, [{ id: 'old' }]);
    assert.deepStrictEqual(managed.definition.runPolicy, { retry: { max: 1 } });
    assert.deepStrictEqual(managed.definition.notificationSettings, { onFailure: { enabled: false } });
    assert.strictEqual(managed.definition, row.liveDefinition, 'the live copy itself, no overlay');

    const unmanaged = definitionForRun(row, { mode: 'live', triggerKind: 'schedule' });
    assert.deepStrictEqual(unmanaged.definition.runPolicy, { retry: { max: 9 } });
    assert.deepStrictEqual(unmanaged.definition.notificationSettings, { onFailure: { enabled: true, recipients: ['incoming'] } });
});

test('a managed test run uses the live copy: dry run, partial builder run, Test button', () => {
    for (const opts of [{ mode: 'dry_run' }, { mode: 'live', triggerKind: 'manual_step' }, { mode: 'live', triggerKind: 'manual', isTest: true }]) {
        const got = definitionForRun(managedRow(), { ...opts, managed: true });
        assert.strictEqual(got.source, 'live', JSON.stringify(opts));
        assert.strictEqual(got.version, 5);
        assert.deepStrictEqual(got.definition.steps, [{ id: 'old' }]);
        assert.deepStrictEqual(got.definition.runPolicy, { retry: { max: 1 } });
        const a = automationForRun(managedRow(), { ...opts, managed: true });
        assert.strictEqual(a.runsLiveVersion, true);
        assert.strictEqual(a.version, 5);
        assert.strictEqual(a.workingVersion, 7);
        assert.deepStrictEqual(a.definition.steps, [{ id: 'old' }]);
    }
});

test('a managed automation with no live copy is not deployed: automationForRun throws managed_part_not_deployed', () => {
    const row = managedRow({ live_definition_json: null, live_version: null, live_at: null });
    assert.strictEqual(definitionForRun(row, { mode: 'dry_run', managed: true }).source, 'not_deployed');
    for (const opts of [{ mode: 'dry_run' }, { mode: 'live', triggerKind: 'manual_step' }, { mode: 'live', isTest: true }, { mode: 'live', triggerKind: 'manual' }]) {
        assert.throws(() => automationForRun(row, { ...opts, managed: true }), (err) => {
            assert.strictEqual(err.status, 409);
            assert.strictEqual(err.code, 'managed_part_not_deployed');
            assert.strictEqual(err.errorClass, 'managed_part_not_deployed');
            assert.strictEqual(err.expose, true);
            return true;
        }, JSON.stringify(opts));
    }
    // Unmanaged, the same row still runs its working copy (unchanged).
    assert.strictEqual(automationForRun(row, { mode: 'live' }), row);
});

test('managed: a caller-built synthetic keeps the definition its caller chose', () => {
    const chosen = automationForRun(managedRow(), { mode: 'live', triggerKind: 'manual_step', managed: true });
    const synthetic = { ...chosen, definition: { trigger: { id: 'x' }, steps: [{ id: 'partial' }] } };
    const again = automationForRun(synthetic, { mode: 'live', triggerKind: 'manual_step', managed: true });
    assert.deepStrictEqual(again.definition.steps, [{ id: 'partial' }]);
    assert.strictEqual(again, synthetic);
    // A Reusable Step is never swapped, managed or not.
    const block = managedRow({ kind: 'block' });
    assert.strictEqual(automationForRun(block, { mode: 'live', managed: true }), block);
});

test('managed selection on an unmanaged result re-reads the live settings it carries', () => {
    const unmanaged = automationForRun(managedRow(), { mode: 'live', triggerKind: 'manual' });
    assert.deepStrictEqual(unmanaged.definition.runPolicy, { retry: { max: 9 } }, 'working settings overlaid');
    assert.strictEqual(Object.keys(unmanaged).includes('liveDefinition'), false, 'the live copy stays non-enumerable');
    assert.strictEqual(JSON.stringify(unmanaged).includes('"liveDefinition"'), false);
    const managed = automationForRun(unmanaged, { mode: 'live', triggerKind: 'manual', managed: true });
    assert.deepStrictEqual(managed.definition.runPolicy, { retry: { max: 1 } });
    assert.strictEqual(managed.version, 5);
    assert.strictEqual(managed.workingVersion, 7, 'the working version survives a second selection');
    assert.strictEqual(automationForRun(managed, { mode: 'live', managed: true }), managed, 'idempotent');
});

test('managed: a spread that was not chosen from the live copy is refused, never run as the working copy', () => {
    // A raw row spread (the non-enumerable live copy dropped) carries the
    // WORKING copy, which during a deploy's prepare is the incoming release.
    const undeployed = managedRow({ live_definition_json: null, live_version: null, live_at: null });
    for (const opts of [{ mode: 'live', isTest: true }, { mode: 'dry_run' }, { mode: 'live', triggerKind: 'schedule' }]) {
        assert.throws(() => automationForRun({ ...undeployed }, { ...opts, managed: true }),
            (err) => err.status === 409 && err.code === 'managed_part_not_deployed', JSON.stringify(opts));
        assert.throws(() => automationForRun({ ...managedRow() }, { ...opts, managed: true }),
            (err) => err.code === 'managed_part_not_deployed', 'a deployed row spread too: ' + JSON.stringify(opts));
    }
    assert.strictEqual(definitionForRun({ ...managedRow() }, { mode: 'live', managed: true }).source, 'not_deployed');
    // An unmanaged TEST selection returns the working row itself; spreading it
    // must not smuggle the working copy into a managed run either.
    const testSel = automationForRun(managedRow(), { mode: 'live', isTest: true });
    assert.strictEqual(testSel.runsLiveVersion, undefined);
    assert.throws(() => automationForRun({ ...testSel, needsFirstRunConfirm: false }, { mode: 'live', managed: true }),
        (err) => err.code === 'managed_part_not_deployed');
    // Unmanaged, a spread still runs exactly what its caller chose (unchanged).
    const spread = { ...managedRow() };
    assert.strictEqual(automationForRun(spread, { mode: 'live' }), spread);
});

test('managed: a resumed test run pinned to a deployed version keeps its steps, with the live settings', () => {
    // resume.js: a test-run selection (the row itself), spread, then pinned to
    // the version the run started on (the live one), working settings laid over.
    const row = managedRow();
    const fallback = automationForRun(row, { mode: 'live', isTest: true });
    const pinnedDef = withWorkingSettings({ ...row.liveDefinition, steps: [{ id: 'pinned' }] }, row.definition);
    const resumed = { ...fallback, definition: pinnedDef, version: 5 };
    const got = automationForRun(resumed, { mode: 'live', isTest: true, managed: true, liveDefinition: row.liveDefinition });
    assert.deepStrictEqual(got.definition.steps, [{ id: 'pinned' }]);
    assert.strictEqual(got.version, 5);
    assert.deepStrictEqual(got.definition.runPolicy, { retry: { max: 1 } }, 'live settings, not the working ones');
    assert.deepStrictEqual(got.definition.notificationSettings, { onFailure: { enabled: false } });
    // Pinned to an older deployed version: still allowed.
    assert.strictEqual(definitionForRun({ ...resumed, version: 3 }, { mode: 'live', managed: true }).source, 'live');
    // Pinned to the working version (the incoming release): refused.
    assert.throws(() => automationForRun({ ...resumed, version: 7 }, { mode: 'live', isTest: true, managed: true }),
        (err) => err.code === 'managed_part_not_deployed');
    // The live copy is gone (store says no live version): refused.
    assert.throws(() => automationForRun({ ...resumed, liveVersion: null }, { mode: 'live', managed: true }),
        (err) => err.code === 'managed_part_not_deployed');
});

test('managed: a spread of an unmanaged live selection gets the live settings from the store copy', () => {
    const row = managedRow();
    const live = automationForRun(row, { mode: 'live', triggerKind: 'manual' });
    const spread = { ...live, needsFirstRunConfirm: false };
    assert.deepStrictEqual(spread.definition.runPolicy, { retry: { max: 9 } }, 'working settings before');
    const got = automationForRun(spread, { mode: 'live', triggerKind: 'manual', managed: true, liveDefinition: row.liveDefinition });
    assert.deepStrictEqual(got.definition.steps, [{ id: 'old' }]);
    assert.deepStrictEqual(got.definition.runPolicy, { retry: { max: 1 } });
    assert.deepStrictEqual(got.definition.notificationSettings, { onFailure: { enabled: false } });
    assert.strictEqual(got.version, 5);
    assert.strictEqual(got.workingVersion, 7);
    // The same spread with a store that has no live copy any more is refused.
    assert.throws(() => automationForRun({ ...spread, liveVersion: null }, { mode: 'live', managed: true }),
        (err) => err.code === 'managed_part_not_deployed');
});

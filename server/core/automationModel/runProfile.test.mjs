/**
 * The run profile: the presets, the stop bound of a partial run, the stored
 * round trip, and the gate of this module: a LEGACY row (no run_profile)
 * derives exactly today's isTestRun for every mode / trigger kind / isTest.
 *
 * Run: cd server && node --test core/automationModel/runProfile.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    profileFor, profileOfRun, legacyProfile, normalizeProfile, stopAfterFor, testPauseTtlMs, kindOf,
    DEFAULT_TEST_PAUSE_TTL_MS,
} from './runProfile.mts';

const require = createRequire(import.meta.url);
const { isTestRun, definitionForRun } = require('../automationRunner/definitionForRun.js');

const NO_ENV = {};

test('production: configured approvers, owner notified, answers recorded, holds the marker', () => {
    const p = profileFor({ mode: 'live', triggerKind: 'webhook' }, NO_ENV);
    assert.deepEqual(p, {
        v: 1, kind: 'production', copy: 'live', effects: 'real', pauses: 'real',
        approverSeat: { kind: 'configured' },
        notify: { outcome: true, approvers: true, tester: false },
        answers: 'production', stopAfterStepId: null, holdsMarker: true, pauseTtlMs: null, origin: 'trigger',
    });
});

test('test (Run live (test)): real effects, the starter holds the seat, only the tester hears, no answers, no marker', () => {
    const p = profileFor({ mode: 'live', triggerKind: 'manual', isTest: true, startedByUserId: 'u-tester', ownerUserId: 'u-owner' }, NO_ENV);
    assert.deepEqual(p, {
        v: 1, kind: 'test', copy: 'working', effects: 'real', pauses: 'real',
        approverSeat: { kind: 'tester', userId: 'u-tester' },
        notify: { outcome: false, approvers: false, tester: true },
        answers: 'none', stopAfterStepId: null, holdsMarker: false, pauseTtlMs: DEFAULT_TEST_PAUSE_TTL_MS, origin: 'builder',
    });
});

test('test without a recorded starter: the owner holds the sandbox seat', () => {
    const p = profileFor({ mode: 'live', isTest: true, ownerUserId: 'u-owner' }, NO_ENV);
    assert.deepEqual(p.approverSeat, { kind: 'tester', userId: 'u-owner' });
});

test('▶ Execute (manual_step) is a test run from the builder step', () => {
    const p = profileFor({ mode: 'live', triggerKind: 'manual_step', startedByUserId: 'u1' }, NO_ENV);
    assert.equal(p.kind, 'test');
    assert.equal(p.origin, 'builder_step');
    assert.equal(p.holdsMarker, false);
});

test('dry: simulated effects, nobody notified, pauses by who asked', () => {
    const headless = profileFor({ mode: 'dry_run', triggerKind: 'dry_run', startedByUserId: 'u1' }, NO_ENV);
    assert.deepEqual(headless, {
        v: 1, kind: 'dry', copy: 'working', effects: 'simulated', pauses: 'synthesise',
        approverSeat: { kind: 'tester', userId: 'u1' },
        notify: { outcome: false, approvers: false, tester: false },
        answers: 'none', stopAfterStepId: null, holdsMarker: false, pauseTtlMs: DEFAULT_TEST_PAUSE_TTL_MS, origin: 'builder',
    });
    assert.equal(profileFor({ mode: 'dry_run', pausesRequested: true }, NO_ENV).pauses, 'real');
    assert.equal(profileFor({ mode: 'dry_run', harness: { source: { kind: 'scenario' } } }, NO_ENV).pauses, 'harness');
    // A harness supplies the answers, so it wins over a request to pause.
    assert.equal(profileFor({ mode: 'dry_run', harness: {}, pausesRequested: true }, NO_ENV).pauses, 'harness');
    assert.equal(profileFor({ mode: 'dry_run', origin: 'mcp' }, NO_ENV).origin, 'mcp');
});

test('origin: an explicit known origin wins, an unknown one is derived', () => {
    assert.equal(profileFor({ mode: 'live', isTest: true, origin: 'test_link' }, NO_ENV).origin, 'test_link');
    assert.equal(profileFor({ mode: 'live', origin: 'nonsense' }, NO_ENV).origin, 'trigger');
    assert.equal(profileFor({ mode: 'live', origin: 'api' }, NO_ENV).origin, 'api');
});

test('AUTOMATION_TEST_PAUSE_TTL_MS: default 24 h, 0 = the step\'s own deadline, junk = default', () => {
    assert.equal(testPauseTtlMs({}), 24 * 60 * 60 * 1000);
    assert.equal(testPauseTtlMs({ AUTOMATION_TEST_PAUSE_TTL_MS: '0' }), null);
    assert.equal(testPauseTtlMs({ AUTOMATION_TEST_PAUSE_TTL_MS: '600000' }), 600000);
    assert.equal(testPauseTtlMs({ AUTOMATION_TEST_PAUSE_TTL_MS: 'soon' }), DEFAULT_TEST_PAUSE_TTL_MS);
    assert.equal(testPauseTtlMs({ AUTOMATION_TEST_PAUSE_TTL_MS: '-5' }), DEFAULT_TEST_PAUSE_TTL_MS);
    assert.equal(testPauseTtlMs({ AUTOMATION_TEST_PAUSE_TTL_MS: ' ' }), DEFAULT_TEST_PAUSE_TTL_MS);
    assert.equal(profileFor({ mode: 'live', isTest: true }, { AUTOMATION_TEST_PAUSE_TTL_MS: '0' }).pauseTtlMs, null);
    // Production always waits for the step's own deadline.
    assert.equal(profileFor({ mode: 'live' }, { AUTOMATION_TEST_PAUSE_TTL_MS: '1000' }).pauseTtlMs, null);
});

test('stopAfterStepId: the target of only / upTo in the root graph; none for from, loops and flowlets', () => {
    assert.equal(stopAfterFor({ mode: 'only', targetStepId: 's1' }), 's1');
    assert.equal(stopAfterFor({ mode: 'upTo', targetStepId: 's1', scope: 'root' }), 's1');
    assert.equal(stopAfterFor({ mode: 'from', targetStepId: 's1' }), null);
    assert.equal(stopAfterFor({ mode: 'only', targetStepId: 's1', scope: 'loop' }), null);
    assert.equal(stopAfterFor({ mode: 'upTo', targetStepId: 's1', scope: 'layer' }), null);
    assert.equal(stopAfterFor({ mode: 'only', targetStepId: null }), null);
    assert.equal(stopAfterFor(null), null);
    const p = profileFor({ mode: 'live', triggerKind: 'manual_step', partial: { mode: 'only', targetStepId: 'appr' } }, NO_ENV);
    assert.equal(p.stopAfterStepId, 'appr');
});

test('copy: a managed automation runs its live copy, test runs included; the recorded copy wins', () => {
    assert.equal(profileFor({ mode: 'live', isTest: true, managed: true }, NO_ENV).copy, 'live');
    assert.equal(profileFor({ mode: 'dry_run', managed: true }, NO_ENV).copy, 'live');
    assert.equal(profileFor({ mode: 'live', copy: 'working' }, NO_ENV).copy, 'working');
    // And definitionForRun agrees: managed selects the live copy for a test run.
    const row = { id: 'a', kind: 'automation', definition: { steps: ['w'] }, version: 3, liveDefinition: { steps: ['l'] }, liveVersion: 2 };
    assert.equal(definitionForRun(row, { mode: 'dry_run', managed: true }).source, 'live');
    assert.equal(definitionForRun(row, { mode: 'dry_run' }).source, 'working');
});

// ── The gate: legacy rows keep today's semantics ─────────────────────────────

const MODES = ['live', 'dry_run', undefined, null];
const TRIGGER_KINDS = ['manual', 'manual_step', 'dry_run', 'form', 'webhook', 'schedule', 'app_event', 'agent', 'automation_call', 'first_run_confirm', null, undefined];
const IS_TEST = [true, false, undefined, null];
/** isTestRun as it was written before the run profile. */
const legacyIsTestRun = ({ mode = 'live', triggerKind = null, isTest = false } = {}) => !!isTest || mode === 'dry_run' || new Set(['manual_step', 'dry_run']).has(triggerKind);

test('for every mode / triggerKind / isTest: isTestRun, profileFor and a legacy row agree with the old rule', () => {
    let n = 0;
    for (const mode of MODES) {
        for (const triggerKind of TRIGGER_KINDS) {
            for (const isTest of IS_TEST) {
                const facts = {};
                if (mode !== undefined) facts.mode = mode;
                if (triggerKind !== undefined) facts.triggerKind = triggerKind;
                if (isTest !== undefined) facts.isTest = isTest;
                const expected = legacyIsTestRun({ mode: mode ?? undefined, triggerKind: triggerKind ?? undefined, isTest: isTest ?? undefined });
                const label = JSON.stringify(facts);
                assert.equal(isTestRun(facts), expected, `isTestRun ${label}`);
                assert.equal(profileFor(facts, NO_ENV).kind !== 'production', expected, `profileFor ${label}`);
                // A legacy row as the store maps it (mode NOT NULL, defaults 'live').
                const row = { mode: mode ?? 'live', triggerKind: triggerKind ?? null, isTest: !!isTest };
                assert.equal(profileOfRun(row).kind !== 'production', legacyIsTestRun(row), `profileOfRun ${label}`);
                // And the raw (snake_case) row reads the same.
                const raw = { mode: row.mode, trigger_kind: row.triggerKind, is_test: row.isTest, run_profile: null };
                assert.deepEqual(profileOfRun(raw), profileOfRun(row), `raw row ${label}`);
                n++;
            }
        }
    }
    assert.equal(n, MODES.length * TRIGGER_KINDS.length * IS_TEST.length);
});

test('a legacy row resumes as it ran: configured approvers, marker for live, no bound, dry synthesises', () => {
    for (const row of [
        { mode: 'live', triggerKind: 'webhook', isTest: false },
        { mode: 'live', triggerKind: 'manual', isTest: true },
        { mode: 'live', triggerKind: 'manual_step', isTest: true },
    ]) {
        const p = profileOfRun(row);
        assert.deepEqual(p.approverSeat, { kind: 'configured' });
        assert.equal(p.holdsMarker, true, 'a live-mode run held the marker');
        assert.equal(p.stopAfterStepId, null, 'no bound was ever stored');
        assert.equal(p.pauses, 'real');
        assert.equal(p.effects, 'real');
        assert.equal(p.answers, 'production');
        assert.equal(p.notify.approvers, true);
        assert.equal(p.notify.outcome, p.kind === 'production');
        assert.equal(p.pauseTtlMs, null);
    }
    const dry = profileOfRun({ mode: 'dry_run', triggerKind: 'dry_run', isTest: true });
    assert.equal(dry.kind, 'dry');
    assert.equal(dry.pauses, 'synthesise');
    assert.equal(dry.effects, 'simulated');
    assert.equal(dry.holdsMarker, false);
    assert.equal(profileOfRun(null).kind, 'production');
    assert.deepEqual(legacyProfile({ mode: 'live', triggerKind: 'manual_step' }).origin, 'builder_step');
});

test('kindOf is the single rule behind both', () => {
    assert.equal(kindOf({ mode: 'dry_run', isTest: false }), 'dry');
    assert.equal(kindOf({ mode: 'live', triggerKind: 'dry_run' }), 'test');
    assert.equal(kindOf({}), 'production');
});

// ── Stored profiles ─────────────────────────────────────────────────────────

test('a stored profile reads back as stored (object, JSON text, under every row key)', () => {
    const p = profileFor({ mode: 'live', triggerKind: 'manual_step', startedByUserId: 'u1', partial: { mode: 'upTo', targetStepId: 'fp' } }, NO_ENV);
    assert.deepEqual(profileOfRun({ profile: p, mode: 'live' }), p);
    assert.deepEqual(profileOfRun({ runProfile: p }), p);
    assert.deepEqual(profileOfRun({ run_profile: JSON.stringify(p) }), p);
    // The stored profile wins over the legacy columns.
    assert.equal(profileOfRun({ profile: p, mode: 'live', isTest: false, triggerKind: 'webhook' }).kind, 'test');
});

test('a stored profile that is not v1 falls back to the legacy derivation; a partial one is completed', () => {
    assert.equal(normalizeProfile({ v: 2, kind: 'test' }), null);
    assert.equal(normalizeProfile({ v: 1, kind: 'weird' }), null);
    assert.equal(normalizeProfile('not json'), null);
    assert.equal(profileOfRun({ profile: { v: 2 }, mode: 'dry_run' }).kind, 'dry');
    const completed = normalizeProfile({ v: 1, kind: 'test', stopAfterStepId: 's9', holdsMarker: 'yes', pauses: 'bogus' });
    assert.equal(completed.stopAfterStepId, 's9');
    assert.equal(completed.holdsMarker, false, 'the test preset');
    assert.equal(completed.pauses, 'real', 'the test preset');
    assert.equal(completed.answers, 'none');
    assert.deepEqual(completed.approverSeat, { kind: 'tester', userId: null });
});

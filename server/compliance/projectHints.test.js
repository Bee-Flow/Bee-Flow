'use strict';

/**
 * The project hint rules: allow-list only, the right role, never a viewer,
 * never when an admin decided, dismiss until it changes, snooze until a date.
 *
 * Run: cd server && node --test compliance/projectHints.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const hints = require('./projectHints');
const findingState = require('./findingState');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const ACTIVE = new Set(['GDPR', 'ISO27001']);
const ROWS = [
    { check_id: 'GDPR-Art32-project-access', scope_id: null, status: 'fail',
      evidence: { offenders: [{ project_id: 'p1', foreign: 2, dangling: 1 }, { project_id: 'p2', foreign: 0, dangling: 3 }] } },
    { check_id: 'ISO27001-A.5.18-project-orphaned-content', scope_id: null, status: 'warn',
      evidence: { offenders: [{ project_id: 'p1', owner_left: false, threads: 1, notebooks: 1 }, { project_id: 'p3', owner_left: true, threads: 4 }] } },
    { check_id: 'GDPR-Art32-project-files-unscanned', scope_id: null, status: 'warn', evidence: { offenders: [{ project_id: 'p1', unscanned: 5 }] } },
    // Never an end-user hint, whatever it says.
    { check_id: 'GDPR-Art30-project-personal-data', scope_id: 'project:p1', status: 'fail', evidence: { project_id: 'p1' } },
];

test('the owner gets the allow-listed hints in priority order, with counts and a deep link', () => {
    const list = hints.candidates({ projectId: 'p1', role: 'owner', rows: ROWS, active: ACTIVE, states: [], now: NOW });
    assert.deepStrictEqual(list.map(h => h.key), ['project_foreign_members', 'project_dangling_members', 'project_orphaned_content', 'project_files_unscanned']);
    assert.deepStrictEqual(hints.publicHint(list[0]), {
        key: 'project_foreign_members', severity: 'high', titleKey: 'compliance.project_hint.project_foreign_members',
        params: { count: 2 }, action: { kind: 'navigate', target: '/app/projects/p1/members' },
    });
    assert.strictEqual(list[3].action.target, '/app/projects/p1/knowledge');
    assert.ok(!list.some(h => /personal/.test(h.key)), 'never "this project contains personal data"');
});

test('an editor only hears about unscanned files; a viewer about nothing', () => {
    assert.deepStrictEqual(hints.candidates({ projectId: 'p1', role: 'editor', rows: ROWS, active: ACTIVE, states: [] }).map(h => h.key), ['project_files_unscanned']);
    assert.deepStrictEqual(hints.candidates({ projectId: 'p1', role: 'viewer', rows: ROWS, active: ACTIVE, states: [] }), []);
});

test('an owner who left leaves no hint to anyone; another project gets only its own', () => {
    assert.deepStrictEqual(hints.candidates({ projectId: 'p3', role: 'owner', rows: ROWS, active: ACTIVE, states: [] }), []);
    assert.deepStrictEqual(hints.candidates({ projectId: 'p2', role: 'owner', rows: ROWS, active: ACTIVE, states: [] }).map(h => h.key), ['project_dangling_members']);
});

test('an inactive framework or an admin decision silences the hint', () => {
    assert.deepStrictEqual(hints.candidates({ projectId: 'p1', role: 'owner', rows: ROWS, active: new Set(['GDPR']), states: [] })
        .map(h => h.key), ['project_foreign_members', 'project_dangling_members', 'project_files_unscanned']);
    const decided = [{ check_id: 'GDPR-Art32-project-access', scope_key: 'global', fingerprint: findingState.fingerprintOf(ROWS[0]), state: 'accepted_risk' }];
    assert.deepStrictEqual(hints.candidates({ projectId: 'p1', role: 'owner', rows: ROWS, active: ACTIVE, states: decided, now: NOW })
        .map(h => h.key), ['project_orphaned_content', 'project_files_unscanned']);
});

test('a dismissal holds until the count changes; a snooze until its date', () => {
    const list = hints.candidates({ projectId: 'p1', role: 'editor', rows: ROWS, active: ACTIVE, states: [] });
    const fp = hints.hintFingerprint('project_files_unscanned', 5);
    assert.strictEqual(hints.pick(list, { project_files_unscanned: { fingerprint: fp, dismissedAt: 'x' } }, NOW), null);
    assert.strictEqual(hints.pick(list, { project_files_unscanned: { fingerprint: hints.hintFingerprint('project_files_unscanned', 4), dismissedAt: 'x' } }, NOW).key,
        'project_files_unscanned', 'one more unscanned file brings it back');
    const snoozed = { project_files_unscanned: { snoozedUntil: new Date(NOW + 86400_000).toISOString() } };
    assert.strictEqual(hints.pick(list, snoozed, NOW), null);
    assert.strictEqual(hints.pick(list, snoozed, NOW + 2 * 86400_000).key, 'project_files_unscanned');
    assert.strictEqual(hints.pick([], {}, NOW), null);
});

test('every hint opens a section where the owner can act, never the overview it stands on', () => {
    // Items of people who left: the shared chats when there are any (they are
    // listed under Chats), the notebooks otherwise.
    const orphaned = (offender) => hints.candidates({
        projectId: 'p9', role: 'owner', active: ACTIVE, states: [], now: NOW,
        rows: [{ check_id: 'ISO27001-A.5.18-project-orphaned-content', scope_id: null, status: 'warn', evidence: { offenders: [offender] } }],
    })[0];
    assert.strictEqual(orphaned({ project_id: 'p9', owner_left: false, threads: 2, notebooks: 1 }).action.target, '/app/projects/p9/chats');
    assert.strictEqual(orphaned({ project_id: 'p9', owner_left: false, threads: 0, notebooks: 3 }).action.target, '/app/projects/p9/notebooks');
    assert.strictEqual(orphaned({ project_id: 'p9', owner_left: false, notebooks: 1 }).action.target, '/app/projects/p9/notebooks');
    const all = hints.candidates({ projectId: 'p1', role: 'owner', rows: ROWS, active: ACTIVE, states: [], now: NOW });
    for (const h of all) assert.match(h.action.target, /^\/app\/projects\/p1\/[a-z]+$/, `${h.key} opens a section`);
});

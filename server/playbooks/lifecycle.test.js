'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lifecycle');
const recipe = require('./recipes/invoiceTracker');

const fresh = () => recipe.phasesFor({ tableMode: 'new' }, { approvalsAllowed: true });
const statuses = (phases) => phases.map((p) => p.status);

test('the transition table: every legal edge, a few illegal ones', () => {
    for (const [from, to] of [['pending', 'ready'], ['ready', 'running'], ['ready', 'skipped'], ['running', 'awaiting'], ['running', 'failed'], ['awaiting', 'done'], ['awaiting', 'skipped'], ['failed', 'ready'], ['skipped', 'ready'], ['locked', 'skipped'], ['locked', 'ready']]) {
        assert.equal(L.canTransition(from, to), true, `${from}→${to}`);
    }
    for (const [from, to] of [['pending', 'running'], ['ready', 'awaiting'], ['running', 'done'], ['done', 'ready'], ['awaiting', 'running'], ['nope', 'ready']]) {
        assert.equal(L.canTransition(from, to), false, `${from}→${to}`);
    }
});

test('applyTransition stamps the clocks, merges artifacts and throws a coded error on an illegal move', () => {
    const t0 = '2026-09-13T10:00:00.000Z';
    let phases = L.applyTransition(fresh(), 'table', 'running', {}, t0);
    assert.equal(L.phaseByKey(phases, 'table').startedAt, t0);
    phases = L.applyTransition(phases, 'table', 'awaiting', { artifacts: { datatableId: 'tbl_1' }, summary: 'made' }, '2026-09-13T10:00:05.000Z');
    const table = L.phaseByKey(phases, 'table');
    assert.equal(table.finishedAt, '2026-09-13T10:00:05.000Z');
    assert.deepEqual(table.artifacts, { datatableId: 'tbl_1' });
    assert.equal(table.summary, 'made');
    phases = L.applyTransition(phases, 'table', 'done', { artifacts: { rowCount: 3 } });
    assert.deepEqual(L.phaseByKey(phases, 'table').artifacts, { datatableId: 'tbl_1', rowCount: 3 }, 'artifacts merge, never replace');
    assert.throws(() => L.applyTransition(phases, 'table', 'ready'), (e) => e.code === 'illegal_transition' && e.from === 'done' && e.to === 'ready');
    assert.throws(() => L.applyTransition(phases, 'ghost', 'ready'), (e) => e.code === 'unknown_phase');
    assert.equal(fresh()[0].startedAt, null, 'the input is not mutated');
});

test('advance: consent moves the next non-terminal phase to ready; skipped and locked are jumped over; the last consent completes the playbook', () => {
    let phases = L.applyTransition(L.applyTransition(fresh(), 'table', 'running'), 'table', 'awaiting');
    let r = L.advance(phases, 'table');
    assert.equal(r.nextKey, 'routine');
    assert.deepEqual(statuses(r.phases), ['done', 'ready', 'pending', 'pending', 'pending', 'pending']);
    assert.equal(L.currentPhaseKey(r.phases), 'routine');
    assert.equal(L.playbookStatus(r.phases), 'active');
    // routine skipped, fill skipped, app runs, approvals locked → advance from app completes.
    phases = L.applyTransition(r.phases, 'routine', 'skipped');
    phases = L.applyTransition(phases, 'fill', 'skipped');
    phases = L.applyTransition(phases, 'design', 'skipped');
    phases = L.applyTransition(L.applyTransition(L.applyTransition(phases, 'app', 'ready'), 'app', 'running'), 'app', 'awaiting');
    phases = L.applyTransition(phases, 'approvals', 'locked');
    r = L.advance(phases, 'app');
    assert.equal(r.nextKey, null);
    assert.equal(L.playbookStatus(r.phases), 'done');
    assert.equal(L.currentPhaseKey(r.phases), null);
    assert.equal(L.nextPhaseKey(r.phases, 'table'), null);
});

test('composeBriefFor uses the table artifacts and the owner; nothing for the server phases; a missing table is a coded error', () => {
    const base = { userId: 'u_owner', title: 'Facturen', options: { folderPath: '/Invoices-Test' }, phases: fresh() };
    assert.equal(L.composeBriefFor(recipe, 'table', base), null);
    assert.equal(L.composeBriefFor(recipe, 'fill', base), null);
    assert.throws(() => L.composeBriefFor(recipe, 'routine', base), (e) => e.code === 'artifacts_missing');
    const withTable = { ...base, phases: base.phases.map((p) => (p.key === 'table' ? { ...p, artifacts: { datatableId: 'tbl_ac8bd9ea1182', datatableKey: 'facturen', datatableName: 'Facturen', mapping: recipe.schemaMapping(), isMirror: false, hasStatus: true } } : p)) };
    const routine = L.composeBriefFor(recipe, 'routine', withTable);
    assert.match(routine, /\*\*"Facturen"\*\* \(id `tbl_ac8bd9ea1182`, key `facturen`\)/);
    assert.match(routine, /"\/Invoices-Test"/);
    assert.match(L.composeBriefFor(recipe, 'approvals', withTable), /builder_add_approval` with assignee \{userId:"u_owner"\}/);
    assert.match(L.composeBriefFor(recipe, 'approvals', { ...withTable, options: { ...withTable.options, approverGroupId: 'grp_9' } }), /assignee \{groupId:"grp_9"\}/);
    assert.match(L.composeBriefFor(recipe, 'app', withTable), /App name "Facturen"/);
});


test('a failed builder phase can still be lifted by a later successful turn', () => {
    // Both builder stages keep their shell mounted on a failed phase, so the
    // person carries on in the chat and the builder finalises — and that
    // finalize used to 409 for ever, because `failed → awaiting` was illegal.
    assert.ok(L.canTransition('failed', 'awaiting'));
    assert.ok(L.canTransition('failed', 'ready'));
    assert.ok(L.canTransition('failed', 'skipped'));
    // `done` stays a one-way door.
    assert.deepEqual(L.TRANSITIONS.done, []);
    // And the server still runs its own phases: awaiting → running stays out.
    assert.ok(!L.canTransition('awaiting', 'running'));
    // A wedged phase can always be stepped past.
    assert.ok(L.canTransition('running', 'skipped'));
});

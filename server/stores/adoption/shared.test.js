'use strict';
/**
 * The pure pieces of the Adoption read model: periods, ISO weeks, member
 * status, the member rule and the ledger WHERE.
 *
 * Run: cd server && node --test stores/adoption/shared.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('./shared');
const { TEST_SOURCES } = require('../../shared/usageAreas');

const DAY = s.DAY_MS;
const NOW = Date.parse('2026-10-28T12:00:00Z'); // a Wednesday

test('a relative period comes from days, an absolute one from its window', () => {
    const rel = s.periodOf({ startDate: '2026-09-28T12:00:00.000Z', endDate: '2026-10-28T12:00:00.000Z' }, { days: 30 }, NOW);
    assert.deepEqual(rel, { startDate: '2026-09-28T12:00:00.000Z', endDate: '2026-10-28T12:00:00.000Z', days: 30, relative: true });
    const abs = s.periodOf({ startDate: '2026-01-01', endDate: '2026-02-01' }, { startDate: '2026-01-01', endDate: '2026-02-01' }, NOW);
    assert.equal(abs.relative, false);
    assert.equal(abs.days, null);
    assert.equal(abs.startDate, '2026-01-01T00:00:00.000Z');
});

test('the previous period has the same length and ends where this one starts', () => {
    const prev = s.previousPeriod({ startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-11T00:00:00.000Z', days: 10, relative: true });
    assert.equal(prev.startDate, '2026-09-21T00:00:00.000Z');
    assert.equal(prev.endDate, '2026-09-30T23:59:59.999Z', 'half-open: a row at the start of this period is not in the one before');
});

test('ISO weeks start on Monday, carry ISO labels and say whether they are complete', () => {
    const weeks = s.isoWeeksOf('2026-10-07T10:00:00Z', '2026-10-28T12:00:00Z', NOW);
    assert.deepEqual(weeks.map((w) => w.week), ['2026-W41', '2026-W42', '2026-W43', '2026-W44']);
    assert.equal(weeks[0].start, '2026-10-05T00:00:00.000Z');
    assert.equal(weeks[0].end, '2026-10-12T00:00:00.000Z');
    // The period starts on a Wednesday: its first week holds part of the data only.
    assert.deepEqual(weeks.map((w) => w.complete), [false, true, true, false]);
    assert.equal(s.weekKey(weeks[0]), '2026-10-05');
    // Year boundaries: 2026-12-31 is in 2026-W53, 2027-01-04 in 2027-W01.
    assert.equal(s.isoWeekLabel(s.mondayOf(Date.parse('2026-12-31T00:00:00Z'))), '2026-W53');
    assert.equal(s.isoWeekLabel(s.mondayOf(Date.parse('2027-01-04T00:00:00Z'))), '2027-W01');
});

test('a week is complete only when it lies wholly inside the period and before now', () => {
    const monday = s.isoWeeksOf('2026-10-05T00:00:00Z', '2026-10-28T12:00:00Z', NOW);
    assert.equal(monday[0].complete, true, 'a period that starts on Monday midnight covers its first week');
    // A past absolute window that ends on a Wednesday: its last week is partial.
    const past = s.isoWeeksOf('2026-09-07T00:00:00.000Z', '2026-09-23T23:59:59.999Z', NOW);
    assert.deepEqual(past.map((w) => w.complete), [true, true, false]);
    const sunday = s.isoWeeksOf('2026-09-07T00:00:00.000Z', '2026-09-20T23:59:59.999Z', NOW);
    assert.deepEqual(sunday.map((w) => w.complete), [true, true], 'an inclusive end on Sunday night covers the week');
});

test('a long period keeps its last 27 weeks', () => {
    const weeks = s.isoWeeksOf('2025-01-01T00:00:00Z', '2026-10-28T00:00:00Z', NOW);
    assert.equal(weeks.length, s.MAX_WEEKS);
    assert.equal(weeks.at(-1)?.week, '2026-W44');
});

test('member status: AI-active, seen only, dormant, never; unknown for an absolute window', () => {
    const period = { startDate: new Date(NOW - 30 * DAY).toISOString(), endDate: new Date(NOW).toISOString(), days: 30, relative: true };
    const iso = (days) => new Date(NOW - days * DAY).toISOString();
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(90) }, true, period, NOW), 'ai_active');
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(2) }, false, period, NOW), 'seen_only');
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(45) }, false, period, NOW), 'dormant');
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: null, createdAt: iso(3).slice(0, 10) }, false, period, NOW), 'never');
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: null, createdAt: iso(200).slice(0, 10) }, false, period, NOW), 'dormant');
    const short = { ...period, startDate: iso(7), days: 7 };
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(10) }, false, short, NOW), 'unknown', 'seen recently, not in the period');
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(2) }, false, { ...period, relative: false }, NOW), 'unknown');
});

test('member status in a 90-day period: missing for 30+ days is dormant, not seen only', () => {
    const iso = (days) => new Date(NOW - days * DAY).toISOString();
    const period = s.periodOf({}, { days: '90' }, NOW);
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(60) }, false, period, NOW), 'dormant');
    assert.equal(s.memberStatus({ id: 'x', lastSeenAt: iso(20) }, false, period, NOW), 'seen_only');
});

test('members: the org and its groups, without system rows, the operator, pending invitations and guests', async () => {
    const d = {
        isPlatformOperator: (u) => u.id === 'admin',
        userStore: {
            getAllUsers: async () => [
                { id: 'm1', organizationId: 'o1', groups: [] },
                { id: 'm2', organizationId: 'other', groups: '["g1"]' },
                { id: 'm3', organizationId: 'other', groups: ['g9'] },
                { id: 'admin', organizationId: 'o1' },
                { id: 'sys', organizationId: 'o1', isSystem: true },
                { id: 'inv', organizationId: 'o1', status: 'pending' },
                { id: 'guest_1', organizationId: 'o1' },
            ],
            getAllGroups: async () => [{ id: 'g1', organizationId: 'o1', name: 'G1' }, { id: 'g9', organizationId: 'other' }],
        },
    };
    const all = await s.resolveMembers(/** @type {any} */ (d), 'o1');
    assert.deepEqual(all.members.map((m) => m.member.id), ['m1', 'm2']);
    assert.deepEqual(all.groups.map((g) => g.id), ['g1']);
    const g1 = await s.resolveMembers(/** @type {any} */ (d), 'o1', 'g1');
    assert.deepEqual(g1.members.map((m) => m.member.id), ['m2']);
    assert.deepEqual(g1.allGroups.map((g) => g.id), ['g1'], 'every group of the organisation, to name a member\'s other groups');
    assert.deepEqual(all.allGroups, all.groups);
    const foreign = await s.resolveMembers(/** @type {any} */ (d), 'o1', 'g9');
    assert.deepEqual(foreign.members, [], "another organisation's group narrows to nobody");
    assert.deepEqual(foreign.groups, []);
    assert.deepEqual(foreign.allGroups.map((g) => g.id), ['g1']);
});

test('the ledger WHERE: period, organisation, no tool rows, no guests, no operator, no test runs; actors when narrowed', () => {
    const w = s.ledgerWhere({ orgId: 'o1', startDate: 'a', endDate: 'b', actors: ['u1'] });
    assert.match(w.where, /tool_name IS NULL/);
    assert.match(w.where, /organization_id = \$3/);
    assert.match(w.where, /NOT LIKE 'guest\\_%'/);
    assert.match(w.where, /IS DISTINCT FROM \$4/);
    assert.match(w.where, /source IS NULL OR source <> ALL\(\$5::text\[\]\)/);
    assert.match(w.where, /= ANY\(\$6::text\[\]\)/);
    assert.deepEqual(w.params, ['a', 'b', 'o1', 'admin', [...TEST_SOURCES], ['u1']]);
    assert.equal(w.nextIdx, 7);
    assert.equal(s.ledgerWhere({ orgId: 'o1', startDate: 'a', endDate: 'b' }).params.length, 5);
});

test('the vocabulary drives the area of a kind and the sources of an area', () => {
    assert.equal(s.areaOfKind('agent'), 'agents');
    assert.equal(s.areaOfKind('solution'), null);
    assert.ok(s.sourcesOfArea('apps').includes('studio_app_action'));
    const [sources, areas] = s.areaMapArrays();
    assert.equal(sources.length, areas.length);
    assert.equal(s.percent(1, 3), 33.3);
    assert.equal(s.deltaPct(15, 10), 50);
    assert.equal(s.deltaPct(15, 0), null);
});

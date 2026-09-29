/**
 * compliance/calendar — MILESTONES + per-org relevance + "affects" counts.
 *
 * Run: cd server && node --test --test-force-exit compliance/calendar.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const calendar = require('./calendar');
const { MILESTONES } = require('./frameworks');

function policy(overrides = {}) {
    const base = {
        gdpr: { enabled: true, core: true, relevance: 'unknown' },
        aia: { enabled: true, core: true, relevance: 'unknown' },
        iso27001: { enabled: true, core: true, relevance: 'unknown' },
        nis2: { enabled: false, locked: 'ceiling', relevance: 'unknown' },
        cra: { enabled: false, locked: null, relevance: 'relevant' },
        data_act: { enabled: false, locked: null, relevance: 'unknown' },
        pld: { enabled: false, locked: null, relevance: 'unknown' },
        eaa: { enabled: true, locked: null, relevance: 'unknown' },
        dora: { enabled: false, locked: null, relevance: 'not_relevant' },
        machinery: { enabled: false, locked: null, relevance: 'not_relevant' },
    };
    return Object.entries({ ...base, ...overrides }).map(([id, p]) => ({ id, ...p }));
}

let queries;
function deps(over = {}) {
    queries = [];
    return {
        frameworkPolicy: { resolve: async () => policy(over.policy) },
        signals: over.signals === undefined
            ? { listGeneratingAutomations: async () => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }
            : over.signals,
        db: {
            getOne: async (sql) => {
                queries.push(sql);
                if (over.dbThrows) throw new Error('relation does not exist');
                if (/FROM agents/.test(sql)) return { n: 4 };
                if (/FROM webpages/.test(sql)) return { n: 6 };
                if (/automation_form_pages/.test(sql)) return { n: 2 };
                return { n: 0 };
            },
        },
        now: () => 1_000_000,
    };
}

beforeEach(() => calendar.invalidate());

test('default list = relevant + uncertain milestones, sorted by date with undated last', async () => {
    const rows = await calendar.list('org1', { deps: deps() });
    const ids = rows.map(m => m.id);
    assert.ok(ids.includes('aia_art50_enforcement'));
    assert.ok(ids.includes('eaa_in_force'), 'eaa is enabled');
    assert.ok(ids.includes('cra_reporting_duty'), 'a candidate marked relevant counts');
    assert.ok(ids.includes('nis2_in_force'), 'a LOCKED candidate with unknown relevance is still relevant (shown locked, never hidden)');
    assert.ok(ids.includes('data_act_in_force'), 'unknown relevance → relevant');
    assert.ok(!ids.includes('dora_in_force'), 'not_relevant candidates are dropped');
    assert.ok(!ids.includes('machinery_in_force'));
    assert.ok(ids.includes('omnibus_data_part') && ids.includes('nl_uitvoeringswet_ai'), 'uncertain ones always show');
    const dated = rows.filter(m => m.date).map(m => m.date);
    assert.deepEqual(dated, [...dated].sort(), 'dated ascending');
    assert.equal(rows[rows.length - 1].date, null, 'undated last');
    assert.equal(rows[rows.length - 1].expected, '2026-Q4');
    for (const m of rows) {
        assert.deepEqual(Object.keys(m).sort(), ['affects', 'affects_kind', 'date', 'detail_key', 'expected', 'framework_id', 'id', 'kind', 'label_key', 'relevant'].sort());
        assert.equal(m.label_key, `compliance.cal_ms_${m.id}_label`);
    }
});

test('all:true returns every milestone with a relevant flag; not_relevant → false', async () => {
    const rows = await calendar.list('org1', { all: true, deps: deps() });
    assert.equal(rows.length, MILESTONES.length);
    assert.equal(rows.find(m => m.id === 'dora_in_force').relevant, false);
    assert.equal(rows.find(m => m.id === 'aia_annex_iii').relevant, true);
    assert.equal(rows.find(m => m.id === 'dora_in_force').affects, null);
});

test('affects: marking milestones count generating routines + published agents; EAA counts webpages + forms; others null', async () => {
    const rows = await calendar.list('org1', { all: true, deps: deps() });
    const marking = rows.find(m => m.id === 'aia_marking_transition_end');
    assert.deepEqual(marking.affects, { automations: 3, agents: 4, webpages: null, forms: null });
    assert.deepEqual(rows.find(m => m.id === 'aia_art50_enforcement').affects, marking.affects);
    const eaa = rows.find(m => m.id === 'eaa_in_force');
    assert.deepEqual(eaa.affects, { automations: null, agents: null, webpages: 6, forms: 2 });
    assert.equal(rows.find(m => m.id === 'pld_in_force').affects, null, 'releases → no count here');
    assert.equal(rows.find(m => m.id === 'nis2_in_force').affects, null);
    // each count query ran once, not once per milestone
    assert.equal(queries.filter(q => /FROM agents/.test(q)).length, 1);
    assert.equal(queries.filter(q => /FROM webpages/.test(q)).length, 1);
});

test('a count that cannot be read is null, never 0; a missing signals module leaves automations null', async () => {
    const rows = await calendar.list('org1', { all: true, deps: deps({ dbThrows: true, signals: null }) });
    assert.deepEqual(rows.find(m => m.id === 'aia_marking_transition_end').affects, { automations: null, agents: null, webpages: null, forms: null });
    assert.deepEqual(rows.find(m => m.id === 'eaa_in_force').affects, { automations: null, agents: null, webpages: null, forms: null });
});

test('affects are not computed for a milestone the org does not care about', async () => {
    await calendar.list('org1', { all: true, deps: deps({ policy: { eaa: { enabled: false, relevance: 'not_relevant' } } }) });
    assert.equal(queries.filter(q => /FROM webpages/.test(q)).length, 0);
});

test('60 s memo per org; invalidate(orgId) drops it; fresh:true bypasses it', async () => {
    let resolves = 0;
    const d = deps();
    d.frameworkPolicy = { resolve: async () => { resolves++; return policy(); } };
    await calendar.list('orgM', { deps: d });
    await calendar.list('orgM', { deps: d });
    assert.equal(resolves, 1);
    await calendar.list('orgOther', { deps: d });
    assert.equal(resolves, 2, 'memo is per org');
    calendar.invalidate('orgM');
    await calendar.list('orgM', { deps: d });
    assert.equal(resolves, 3);
    await calendar.list('orgM', { deps: d, fresh: true });
    assert.equal(resolves, 4);
    d.now = () => 1_000_000 + calendar.MEMO_MS + 1;
    await calendar.list('orgM', { deps: d });
    assert.equal(resolves, 5, 'expired after MEMO_MS');
});

test('countByFramework sums the catalogue per framework id', () => {
    const c = calendar.countByFramework();
    assert.equal(Object.values(c).reduce((s, x) => s + x, 0), MILESTONES.length);
    assert.equal(c.aia, MILESTONES.filter(m => m.framework_id === 'aia').length);
    assert.ok(c.aia >= 6);
});

test('relevanceOf: enabled wins; unknown framework → false', () => {
    const byId = new Map([['x', { enabled: true, relevance: 'not_relevant' }], ['y', { enabled: false, relevance: 'unknown' }]]);
    assert.equal(calendar.relevanceOf(byId, 'x'), true);
    assert.equal(calendar.relevanceOf(byId, 'y'), true);
    assert.equal(calendar.relevanceOf(byId, 'z'), false);
});

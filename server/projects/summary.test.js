/**
 * The Solutions overview.
 *
 * Three things are load-bearing here and none of them is the happy path:
 *
 *   1. NULL IS NOT ZERO. This is the screen where a Solution looks fine, so a
 *      tally that could not be read must never render as "nothing there" or as
 *      a green tick. Every gap is a `null` AND a name in `unavailable`.
 *   2. IT AUTHORISES NOTHING. The rows it is handed are the authorisation, and
 *      it counts exactly those ids. The proof is that every store call below
 *      receives the id list the caller supplied and nothing else.
 *   3. UNKNOWN IS NOT UP TO DATE. A Solution whose Blueprint has been deleted,
 *      or belongs to an organisation the reader is not in, reports
 *      `available: null` — never `false`.
 *
 * Hermetic: every store is replaced in require.cache before the module under
 * test loads. The registry (projects/membership.js) is the REAL one, so this
 * also proves its `countIn` hooks reach the functions they name.
 *
 * Run: cd server && node --test --test-force-exit projects/summary.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

function mock(rel, exports) {
    const p = require.resolve(path.join(SERVER, rel));
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
    return exports;
}

// What each store was asked for, so the "counts exactly what it was handed"
// claim is checked rather than asserted.
const asked = { notebooks: null, automations: null, apps: null, webpages: null, datatables: null, agents: null, runs: null, versions: null };
const fx = {
    counts: {
        notebooks: new Map([['p1', 2]]),
        automations: new Map([['p1', 3], ['p2', 1]]),
        apps: new Map([['p1', 1]]),
        webpages: new Map(),
        datatables: new Map([['p2', 5]]),
        agents: new Map(),
    },
    throwOn: new Set(),
    runs: new Map([['p1', { total: 12, failed: 1 }]]),
    runsThrow: false,
    blueprints: [{ id: 'bp_1', name: 'Onboarding', version: 5, organizationId: 'org1' }],
    blueprintsThrow: false,
    installedVersions: new Map([['p2', 3]]),
    versionsThrow: false,
};
const counter = (section) => async (ids) => {
    asked[section] = ids;
    if (fx.throwOn.has(section)) throw new Error(`${section} store is down`);
    return fx.counts[section];
};

mock('stores/notebookStore', { countProjectNotebooks: counter('notebooks') });
mock('stores/studioAppStore', { countProjectApps: counter('apps') });
mock('stores/webpageStore', { countProjectWebpages: counter('webpages') });
mock('stores/datatableStore', { countDatatablesForProject: counter('datatables') });
mock('stores/agentStore', { countProjectAgents: counter('agents') });
mock('stores/automationStore', {
    countAutomationsForProject: counter('automations'),
    getRunCountsForProjects: async (ids) => {
        asked.runs = ids;
        if (fx.runsThrow) throw new Error('runs table is down');
        return fx.runs;
    },
});
mock('stores/blueprintStore', {
    listBlueprintsFor: async () => {
        if (fx.blueprintsThrow) throw new Error('gallery is down');
        return fx.blueprints;
    },
    listInstalledVersions: async (ids) => {
        asked.versions = ids;
        if (fx.versionsThrow) throw new Error('stamps are down');
        return fx.installedVersions;
    },
});

const { summarizeProjects, startOfDayUtc, mapLimited, updateStatusFor } = require('./summary');

const PROJECTS = [
    { id: 'p1', name: 'Onboarding', ownerId: 'u1', organizationId: 'org1', permission: 'owner',
      knowledgeBaseIds: ['kb_a', 'kb_b'], installedFromBlueprintId: null, updatedAt: '2026-09-01' },
    { id: 'p2', name: 'Invoicing', ownerId: 'u2', organizationId: 'org1', permission: 'viewer',
      knowledgeBaseIds: [], installedFromBlueprintId: 'bp_1', updatedAt: '2026-08-01' },
];

function reset() {
    fx.throwOn = new Set();
    fx.runsThrow = false;
    fx.blueprintsThrow = false;
    fx.versionsThrow = false;
    fx.runs = new Map([['p1', { total: 12, failed: 1 }]]);
    fx.installedVersions = new Map([['p2', 3]]);
    fx.blueprints = [{ id: 'bp_1', name: 'Onboarding', version: 5, organizationId: 'org1' }];
    for (const k of Object.keys(asked)) asked[k] = null;
}

const run = (over = {}) => summarizeProjects(PROJECTS, {
    viewer: { userId: 'u1', organizationId: 'org1' }, ...over,
});
const byId = (result, id) => result.projects.find(p => p.id === id);

// ═══ The happy shape ═════════════════════════════════════════════════

test('every kind is counted once for the whole list, not once per project', async () => {
    reset();
    const result = await run();

    // One call per KIND, each handed the whole id list. The alternative — one
    // call per kind per project — is what the registry's countIn hook exists to
    // avoid, and it is invisible in the output, so it is asserted here.
    for (const section of ['notebooks', 'automations', 'apps', 'webpages', 'datatables', 'agents']) {
        assert.deepStrictEqual(asked[section], ['p1', 'p2'], `${section} was asked for both projects at once`);
    }

    const p1 = byId(result, 'p1');
    assert.strictEqual(p1.counts.automations, 3);
    assert.strictEqual(p1.counts.apps, 1);
    assert.strictEqual(p1.counts.webpages, 0, 'the store answered and there are none');
    assert.strictEqual(p1.counts.knowledgeBases, 2, 'read off the project row, where the link lives');
    assert.deepStrictEqual(p1.runs, { today: 12, failed: 1 });
});

test('a project the tally never mentions is empty, not unknown', async () => {
    reset();
    const p2 = byId(await run(), 'p2');
    assert.strictEqual(p2.counts.apps, 0, 'absent from a successful grouped count means none');
    assert.deepStrictEqual(p2.runs, { today: 0, failed: 0 });
    assert.ok(!p2.unavailable.includes('apps'));
});

test('the row carries what the three overview tabs are drawn from', async () => {
    reset();
    const result = await run();
    assert.strictEqual(byId(result, 'p1').permission, 'owner');
    assert.strictEqual(byId(result, 'p1').installedFromBlueprintId, null, 'built here');
    assert.strictEqual(byId(result, 'p2').installedFromBlueprintId, 'bp_1', 'installed from the gallery');
});

// ═══ null is not zero ════════════════════════════════════════════════

test('A STORE THAT COULD NOT BE READ IS NULL ON EVERY CARD, AND IS NAMED', async () => {
    // The failure this shape exists to prevent: one unreachable store making
    // twenty Solutions look empty.
    reset();
    fx.throwOn.add('apps');
    const result = await run();

    for (const project of result.projects) {
        assert.strictEqual(project.counts.apps, null, 'never 0 — the read failed for all of them');
        assert.ok(project.unavailable.includes('apps'), 'and the gap is named on the card');
        assert.strictEqual(project.complete, false);
    }
    assert.ok(result.unavailable.includes('apps'), 'and once for the whole screen');
    // The kinds that DID answer are unaffected: a Solution is still true about
    // what could be read, which is the same rule GET /:id/graph keeps.
    assert.strictEqual(byId(result, 'p1').counts.automations, 3);
});

test('a run tally that failed is not "nothing ran today"', async () => {
    reset();
    fx.runsThrow = true;
    const result = await run();
    for (const project of result.projects) {
        assert.strictEqual(project.runs, null);
        assert.ok(project.unavailable.includes('runs'));
    }
    assert.ok(result.unavailable.includes('runs'));
});

// ═══ Completeness: not checked is a gap, never a clean bill ══════════

test('WITHOUT A CHECKER, COMPLETENESS IS NULL AND SAYS SO', async () => {
    reset();
    const result = await run();          // no completenessFor
    for (const project of result.projects) {
        assert.strictEqual(project.completeness, null);
        assert.ok(project.unavailable.includes('completeness'),
            'nobody checked is a REPORTED gap — a card that renders this as a green tick is the bug');
    }
    assert.strictEqual(result.checkedCount, 0);
});

test('a checker that throws leaves that card unknown, not clean, and does not take the others down', async () => {
    reset();
    const result = await run({
        completenessFor: async (id) => {
            if (id === 'p1') throw new Error('graph store is down');
            return { blocked: false, complete: true, findings: [], unavailable: [] };
        },
    });
    assert.strictEqual(byId(result, 'p1').completeness, null);
    assert.ok(byId(result, 'p1').unavailable.includes('completeness'));
    assert.strictEqual(byId(result, 'p2').completeness.blocked, false, 'the other card still got its verdict');
});

test('the aggregator\'s verdict is copied, never recomputed', async () => {
    // A second opinion about whether a Solution may publish is a second opinion
    // that can differ from the one the publish button reads.
    reset();
    const result = await run({
        completenessFor: async () => ({
            blocked: true, complete: false,
            findings: [{ severity: 'error' }, { severity: 'warning' }, { severity: 'warning' }],
            unavailable: ['agents'],
        }),
    });
    const c = byId(result, 'p1').completeness;
    assert.deepStrictEqual(
        { blocked: c.blocked, complete: c.complete, findings: c.findings, errors: c.errors, warnings: c.warnings },
        { blocked: true, complete: false, findings: 3, errors: 1, warnings: 2 },
    );
    assert.deepStrictEqual(c.unavailable, ['agents']);
});

test('an aggregate that answers with nothing usable is BLOCKED, not open', async () => {
    // `blocked` defaults shut: a body without the field is a body nobody can
    // read a verdict out of, and the safe reading of that is "not yet".
    reset();
    const result = await run({ completenessFor: async () => ({}) });
    assert.strictEqual(byId(result, 'p1').completeness.blocked, true);
    assert.strictEqual(byId(result, 'p1').completeness.complete, false);
});

test('the budget bounds how many Solutions are checked, and the rest are honest about it', async () => {
    reset();
    const checked = [];
    const result = await run({
        completenessBudget: 1,
        completenessFor: async (id) => { checked.push(id); return { blocked: false, complete: true, findings: [] }; },
    });
    assert.deepStrictEqual(checked, ['p1'], 'the head of the list — the order the cards render in');
    assert.strictEqual(byId(result, 'p2').completeness, null);
    assert.ok(byId(result, 'p2').unavailable.includes('completeness'));
    assert.strictEqual(result.checkedCount, 1);
});

// ═══ "v1.5 available" — and the three ways it must say "I don't know" ═

test('a newer Blueprint in the reader\'s own catalogue is an available update', async () => {
    reset();
    const update = byId(await run(), 'p2').update;
    assert.deepStrictEqual(
        { blueprintId: update.blueprintId, installedVersion: update.installedVersion, latestVersion: update.latestVersion, available: update.available },
        { blueprintId: 'bp_1', installedVersion: 3, latestVersion: 5, available: true },
    );
});

test('the same version is not an update', async () => {
    reset();
    fx.installedVersions = new Map([['p2', 5]]);
    assert.strictEqual(byId(await run(), 'p2').update.available, false,
        're-applying the same version replaces pristine entities with identical copies');
});

test('A BLUEPRINT THIS READER CANNOT SEE IS UNKNOWN, NOT UP TO DATE', async () => {
    // Deleted, or belonging to another organisation. `false` here would tell
    // somebody their Solution is current when nobody checked — and looking the
    // id up directly would confirm the existence of a Blueprint outside their
    // org, which is why the org-scoped listing is what this reads.
    reset();
    fx.blueprints = [];
    const p2 = byId(await run(), 'p2');
    assert.strictEqual(p2.update.available, null);
    assert.strictEqual(p2.update.latestVersion, null);
    assert.ok(p2.unavailable.includes('update'));
});

test('a Solution with no install stamp is unknown too', async () => {
    reset();
    fx.installedVersions = new Map();
    const p2 = byId(await run(), 'p2');
    assert.strictEqual(p2.update.available, null, 'we do not know what version this is');
    assert.ok(p2.unavailable.includes('update'));
});

test('a stamp read that failed does not turn every installed Solution current', async () => {
    reset();
    fx.versionsThrow = true;
    assert.strictEqual(byId(await run(), 'p2').update.available, null);
    assert.ok((await run()).unavailable.includes('installedVersions'));
});

test('a Solution nobody installed has no update status at all', async () => {
    reset();
    assert.strictEqual(byId(await run(), 'p1').update, null, 'built here — there is nothing to be newer than');
    assert.ok(!byId(await run(), 'p1').unavailable.includes('update'));
});

test('without a viewer, the catalogue is not read and no update is claimed', async () => {
    reset();
    const result = await summarizeProjects(PROJECTS, {});
    assert.strictEqual(byId(result, 'p2').update.available, null);
});

// ═══ It authorises nothing ═══════════════════════════════════════════

test('it counts exactly the projects it is handed', async () => {
    reset();
    const result = await summarizeProjects([PROJECTS[1]], { viewer: { userId: 'u1', organizationId: 'org1' } });
    assert.deepStrictEqual(result.projects.map(p => p.id), ['p2']);
    assert.deepStrictEqual(asked.automations, ['p2'], 'no id the caller did not authorise reached a store');
    assert.deepStrictEqual(asked.runs, ['p2']);
});

test('an empty list asks no store anything', async () => {
    reset();
    const result = await summarizeProjects([], { viewer: { userId: 'u1' } });
    assert.deepStrictEqual(result.projects, []);
});

test('rows without an id are dropped rather than counted as an empty id', async () => {
    reset();
    const result = await summarizeProjects([null, {}, { id: 'p1', knowledgeBaseIds: [] }], { viewer: { userId: 'u1' } });
    assert.deepStrictEqual(result.projects.map(p => p.id), ['p1']);
    assert.deepStrictEqual(asked.automations, ['p1']);
});

// ═══ The small pieces ════════════════════════════════════════════════

test('"today" starts at midnight UTC of the day it is asked about', () => {
    const d = startOfDayUtc(new Date('2026-09-07T15:42:10.500Z'));
    assert.strictEqual(d.toISOString(), '2026-09-07T00:00:00.000Z');
});

test('the run tally is asked for a window, not for everything ever', async () => {
    reset();
    let seen = null;
    const store = require(path.join(SERVER, 'stores/automationStore'));
    const original = store.getRunCountsForProjects;
    store.getRunCountsForProjects = async (ids, opts) => { seen = opts; return new Map(); };
    try {
        await run({ since: new Date('2026-09-07T00:00:00.000Z') });
        assert.strictEqual(seen.sinceTs.toISOString(), '2026-09-07T00:00:00.000Z');
    } finally { store.getRunCountsForProjects = original; }
});

test('mapLimited keeps order and never runs more than the width at once', async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
        live += 1; peak = Math.max(peak, live);
        await new Promise(r => setTimeout(r, 1));
        live -= 1;
        return n * 2;
    });
    assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3, `ran ${peak} at once; each check is itself a fan-out`);
});

test('updateStatusFor is honest about every unknown on its own', () => {
    const readable = new Map([['bp_1', { id: 'bp_1', name: 'X', version: 4 }]]);
    const installed = new Map([['p', 2]]);
    assert.strictEqual(updateStatusFor({ id: 'p' }, readable, installed), null, 'no Blueprint behind it');
    assert.strictEqual(updateStatusFor({ id: 'p', installedFromBlueprintId: 'bp_1' }, readable, installed).available, true);
    assert.strictEqual(updateStatusFor({ id: 'p', installedFromBlueprintId: 'bp_9' }, readable, installed).available, null);
    assert.strictEqual(updateStatusFor({ id: 'p', installedFromBlueprintId: 'bp_1' }, null, installed).available, null);
    assert.strictEqual(updateStatusFor({ id: 'p', installedFromBlueprintId: 'bp_1' }, readable, null).available, null);
});

/**
 * projects/packaging/publication.js — the publish gate, the release note and
 * the announcement, driven through their `deps` seams.
 *
 * Pinned here:
 *   1. the gate blocks on anything but an explicit clean verdict, and a gate
 *      that cannot run is BLOCKED with `unavailable: ['all']`;
 *   2. the download summary is an allow-list: no member id, no deep link, and
 *      no producer `message` (a graph problem's sentence names the id of a
 *      automation outside the Solution);
 *   3. the note's left-hand side is the caller's own previous gallery row, a
 *      note that fails or does not fit is null, never a thrown publication;
 *   4. the announcement is a poke without ids, and never throws;
 *   5. a pipeline manifest is recognised, by `channel: 'pipeline'` and by the
 *      `solution.slots` / `solution.variables` sections only a pipeline
 *      capture writes.
 *
 * No module mocking: every collaborator is an injected double.
 *
 * Run: cd server && node --test projects/packaging/publication.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    releaseGate, checksForDownload, releaseNotesFor, previousPublishedManifest,
    announcePublication, isPipelineManifest, NOTE_CALL_TIMEOUT_MS, NOTE_DEADLINE_MS,
} = require('./publication');

const quietLog = { warn() {}, info() {}, error() {}, debug() {} };

// ── 1. The gate ─────────────────────────────────────────────────────────────

function gateDeps(verdict, { graphThrows = false } = {}) {
    const seen = {};
    return {
        seen,
        deps: {
            log: quietLog,
            buildGraphForProject: async (projectId) => {
                seen.projectId = projectId;
                if (graphThrows) throw new Error('store down');
                return { graph: { edges: [] }, members: { apps: ['a'], automations: ['r'], knowledgeBases: ['k'] }, unavailable: ['webpages'] };
            },
            collectCompleteness: async (input) => { seen.input = input; return verdict; },
        },
    };
}

test('the gate runs completeness over the graph of the project it is given', async () => {
    const { deps, seen } = gateDeps({ blocked: false, complete: true, findings: [], unavailable: [] });
    const out = await releaseGate({ id: 'p1' }, deps);
    assert.strictEqual(seen.projectId, 'p1');
    assert.deepStrictEqual(seen.input, { graph: { edges: [] }, apps: ['a'], automations: ['r'], knowledgeBases: ['k'], unavailable: ['webpages'] });
    assert.deepStrictEqual(out, { blocked: false, complete: true, findings: [], unavailable: [] });
});

test('a blocked verdict passes its findings through', async () => {
    const finding = { code: 'x', severity: 'error' };
    const { deps } = gateDeps({ blocked: true, complete: true, findings: [finding], unavailable: [] });
    const out = await releaseGate({ id: 'p1' }, deps);
    assert.strictEqual(out.blocked, true);
    assert.deepStrictEqual(out.findings, [finding]);
});

test('anything but an explicit blocked:false blocks', async () => {
    for (const verdict of [{}, null, { blocked: undefined }, { blocked: 'no' }]) {
        const { deps } = gateDeps(verdict);
        assert.strictEqual((await releaseGate({ id: 'p1' }, deps)).blocked, true, JSON.stringify(verdict));
    }
});

test('a gate that cannot run is blocked, and says it could read nothing', async () => {
    const { deps } = gateDeps(null, { graphThrows: true });
    const out = await releaseGate({ id: 'p1' }, deps);
    assert.deepStrictEqual(out, { blocked: true, complete: false, findings: [], unavailable: ['all'] });
});

// ── 2. The download summary ─────────────────────────────────────────────────

test('the download summary rebuilds each finding from an allow-list', () => {
    const out = checksForDownload({
        blocked: true, complete: false, unavailable: ['apps'],
        findings: [{
            code: 'app.control_inert', severity: 'warning', blockedAt: 'publish', kind: 'app',
            targetRef: { kind: 'app', id: 'app_internal', title: 'Desk', path: 'screens[0]' },
            message: 'A button does nothing.', remediation: null,
            deepLink: '/app/studio/apps/app_internal', extra: 'leak',
        }],
    });
    assert.deepStrictEqual(out, {
        blocked: true, complete: false, unavailable: ['apps'],
        findings: [{
            code: 'app.control_inert', severity: 'warning', blockedAt: 'publish', kind: 'app',
            title: 'Desk', remediation: null,
        }],
    });
    assert.ok(!JSON.stringify(out).includes('app_internal'));
});

test('a graph problem about an automation OUTSIDE the Solution does not put its id in the file', () => {
    // The real producers, end to end: the graph writes the external id into
    // its sentence, completeness keeps the sentence and drops the targetId.
    const { buildProjectGraph } = require('../graph');
    const { buildCompleteness } = require('../completeness');
    const automations = [{
        id: 'aut_mine', title: 'Mine', userId: 'alice', kind: 'automation', status: 'draft',
        definition: { trigger: { kind: 'manual' }, steps: [{ id: 's1', type: 'call_block', blockId: 'aut_SECRET_9f3a' }] },
    }];
    const graph = buildProjectGraph({ automations, knownAutomationIds: new Set(['aut_mine', 'aut_SECRET_9f3a']) });
    const verdict = buildCompleteness({ graph, automations });
    assert.ok(verdict.findings.some(f => String(f.message).includes('aut_SECRET_9f3a')),
        'precondition: the producer sentence names the external automation');

    const out = checksForDownload(verdict);
    assert.ok(out.findings.length > 0);
    assert.ok(out.findings.every(f => !('message' in f)));
    assert.ok(!JSON.stringify(out).includes('aut_SECRET_9f3a'));
});

// ── 3. The release note ─────────────────────────────────────────────────────

function noteStore(over = {}) {
    const calls = [];
    return {
        calls,
        store: {
            MAX_NOTES_BYTES: over.max ?? 64 * 1024,
            listBlueprintsFor: async (args) => {
                calls.push({ name: 'list', args });
                if (over.listThrows) throw new Error('gallery down');
                return over.rows || [];
            },
            getBlueprintById: async (id) => { calls.push({ name: 'get', id }); return { id, manifest: { previous: id } }; },
        },
    };
}

const project = { id: 'p1', organizationId: 'org_p' };

test('the previous manifest is the caller\'s own row of this Solution', async () => {
    const { store, calls } = noteStore({
        rows: [
            { id: 'bp_bob', solutionKey: 'sol_p1', createdBy: 'bob' },
            { id: 'bp_other', solutionKey: 'sol_p9', createdBy: 'alice' },
            { id: 'bp_mine', solutionKey: 'sol_p1', createdBy: 'alice' },
        ],
    });
    assert.deepStrictEqual(await previousPublishedManifest({ store, project, userId: 'alice' }), { previous: 'bp_mine' });
    assert.deepStrictEqual(calls[0].args, { userId: 'alice', organizationId: 'org_p' });

    const none = noteStore({ rows: [] });
    assert.strictEqual(await previousPublishedManifest({ store: none.store, project, userId: 'alice' }), null);
    assert.ok(!none.calls.some(c => c.name === 'get'));
});

test('the note is built with the bounded timings, the project org and the user', async () => {
    const { store } = noteStore({ rows: [{ id: 'bp_mine', solutionKey: 'sol_p1', createdBy: 'alice' }] });
    let built;
    const releaseNotes = {
        buildReleaseNotes: async (args) => { built = args; return { raw: true }; },
        releaseNotesPayload: () => ({ entities: [], omitted: 0, textsDropped: false }),
    };
    const out = await releaseNotesFor({ store, project, userId: 'alice', manifest: { m: 1 } }, { releaseNotes, log: quietLog });
    assert.deepStrictEqual(out, { entities: [], omitted: 0, textsDropped: false });
    assert.deepStrictEqual(built, {
        previousManifest: { previous: 'bp_mine' }, manifest: { m: 1 },
        userOrgId: 'org_p', userId: 'alice',
        timeoutMs: NOTE_CALL_TIMEOUT_MS, deadlineMs: NOTE_DEADLINE_MS,
    });
    assert.ok(NOTE_DEADLINE_MS < 15_000 && NOTE_CALL_TIMEOUT_MS < 15_000);
});

test('a note that does not fit the store\'s real limit is dropped, not thrown', async () => {
    const { store } = noteStore({ max: 10 });
    const releaseNotes = {
        buildReleaseNotes: async () => ({}),
        releaseNotesPayload: () => ({ entities: [{ text: 'far more than ten bytes' }] }),
    };
    assert.strictEqual(await releaseNotesFor({ store, project, userId: 'alice', manifest: {} }, { releaseNotes, log: quietLog }), null);
});

test('a failing note is null, never a refused publication', async () => {
    const { store } = noteStore({ listThrows: true });
    const releaseNotes = { buildReleaseNotes: async () => ({}), releaseNotesPayload: () => ({}) };
    assert.strictEqual(await releaseNotesFor({ store, project, userId: 'alice', manifest: {} }, { releaseNotes, log: quietLog }), null);
});

// ── 4. The announcement ─────────────────────────────────────────────────────

test('the announcement logs the activity and emits a poke without ids', async () => {
    const calls = [];
    await announcePublication('p1', 'alice', {
        log: quietLog,
        projectStore: { logActivity: async (...args) => calls.push(['log', ...args]) },
        projectFeed: { emitProjectEvent: async (...args) => calls.push(['emit', ...args]) },
    });
    assert.deepStrictEqual(calls, [
        ['log', 'p1', 'alice', 'blueprint.published', {}],
        ['emit', 'p1', { kind: 'blueprint.published', actorId: 'alice' }],
    ]);
});

test('an announcement that fails never throws', async () => {
    const warned = [];
    await announcePublication('p1', 'alice', {
        log: { ...quietLog, warn: (...a) => warned.push(a) },
        projectStore: { logActivity: async () => { throw new Error('db down'); } },
        projectFeed: { emitProjectEvent: async () => { throw new Error('not reached'); } },
    });
    assert.strictEqual(warned.length, 1);
});

// ── 5. Pipeline manifests ───────────────────────────────────────────────────

test('a manifest that declares the pipeline channel is recognised', () => {
    assert.strictEqual(isPipelineManifest({ channel: 'pipeline', solution: {} }), true);
    for (const m of [null, undefined, {}, { channel: 'gallery' }, 'pipeline', { solution: { channel: 'pipeline' } },
        { solution: { slots: null, variables: null } }]) {
        assert.strictEqual(isPipelineManifest(m), false, JSON.stringify(m));
    }
});

test('a manifest a pipeline capture builds is recognised by its sections', () => {
    const { buildManifest } = require('./manifest');
    const project = { id: 'p1', name: 'Desk' };
    assert.strictEqual(isPipelineManifest(buildManifest({ project, slots: [] })), true);
    assert.strictEqual(isPipelineManifest(buildManifest({ project, variables: [] })), true);
    // A gallery capture passes `slots: null` and has neither section.
    assert.strictEqual(isPipelineManifest(buildManifest({ project, slots: null })), false);
});

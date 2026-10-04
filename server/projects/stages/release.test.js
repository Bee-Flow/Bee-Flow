/**
 * Cutting a pipeline release (design 6.1, D18, D20) against a real Postgres
 * (pglite) through the real blueprint and solution-stage stores; capture,
 * the cut state and the payload reads are injected doubles. No module mocking.
 *
 * Run: cd server && node --test projects/stages/release.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeBlueprintStore, applyBlueprintSchema } = require('../../stores/blueprintStore');
const { makeSolutionStageStore, applySolutionStageSchema } = require('../../stores/solutionStageStore');
const { buildManifest } = require('../packaging/manifest');
const { cutRelease, releaseVariables, connectionIdsOf } = require('./release');

const { pg, db } = pgliteDb();
const blueprintStore = makeBlueprintStore({
    run: (sql, params) => db.query(sql, params),
    getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await db.query(sql, params)).rows,
    withTransaction: (fn) => db.tx(fn),
});
const solutionStageStore = makeSolutionStageStore(db, { projectStore: {} });
const runDdl = async (_tag, statements) => { for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql); };

before(async () => {
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT DEFAULT '', installed_from_blueprint_id TEXT,
                                          stage TEXT, stage_of TEXT)`);
    await applyBlueprintSchema({ exec: (sql) => pg.exec(sql), runDdl });
    await applySolutionStageSchema({ runDdl });
    for (const id of ['dev-1', 'dev-2', 'dev-3', 'dev-4']) await pg.query(`INSERT INTO projects (id, organization_id) VALUES ($1, 'acme')`, [id]);
    await solutionStageStore.replaceVariables('dev-1', [
        { name: 'api_base', type: 'url' },
        { name: 'region', type: 'text', required: false },
        { name: 'callback', type: 'text' },
        { name: 'approver_team', type: 'text', steering: true },
    ]);
    await solutionStageStore.setPartOption('dev-1', { ref: 'dt_1', kind: 'datatable', options: { reference: true } }, 'alice');
});
after(async () => { await pg.close(); });

const devProject = (id = 'dev-1') => ({ id, name: 'Orders', ownerId: 'alice', organizationId: 'acme', stage: null });

/** A capture double: one automation, one table, the automation's title is whatever `world.title` says. */
function makeWorld() {
    const world = { title: 'Invoices', captures: 0, lastConnSlots: null, tokens: 1 };
    world.captureSolution = async ({ project, refs, connSlots, pipeline }) => {
        world.captures += 1;
        world.lastConnSlots = connSlots;
        assert.strictEqual(pipeline, true);
        const manifest = buildManifest({
            project,
            entities: {
                automations: [{ ref: refs.get('a-1'), kind: 'automation', title: world.title, definition: { steps: [{ id: 's', type: 'http_request', url: '{{vars.callback}}', auth: { connectionId: null } }] } }],
                datatables: [{ ref: refs.get('t-1'), key: 'prices', name: 'Prices', columns: [] }],
            },
            report: { problems: [], warnings: ['a capture warning'] },
            slots: [{ slot: `connection:${connSlots.get('conn-dev')}`, kind: 'connection', ref: refs.get('a-1'), stepId: 's', suggested: { connectionId: 'conn-dev' } }],
        });
        return { ok: true, manifest, slots: manifest.solution.slots, rawIds: [], findings: [], steeringNames: ['callback'], cutTokens: { [refs.get('a-1')]: { version: 3 } } };
    };
    world.readCutState = async () => ({
        members: { automations: ['a-1'], datatables: ['t-1'] },
        connections: ['conn-dev'],
        tokens: { 'automation:a-1': { version: world.tokens } },
    });
    world.capturePayloads = async ({ devProject: dev, refs, options }) => {
        if (dev.id === 'dev-1') assert.strictEqual(options.get('dt_1')?.reference, true, 'the part options reach the payload read');
        return {
            payloads: [{ ref: refs.get('t-1'), kind: 'reference_rows', sourceEntityId: 't-1', payload: { rows: [{ id: '1', values: { fld_label: 'Gold tier' } }] }, contentHash: 'rows-v1' }],
            findings: [], referenceRefs: [refs.get('t-1')],
        };
    };
    world.deps = {
        blueprintStore, solutionStageStore,
        releaseGate: async () => ({ blocked: false, complete: true, findings: [{ code: 'kb.empty', severity: 'warning' }], unavailable: [] }),
        captureSolution: (...a) => world.captureSolution(...a),
        readCutState: (...a) => world.readCutState(...a),
        capturePayloads: (...a) => world.capturePayloads(...a),
        ownersOf: async () => new Map(),
    };
    return world;
}

test('a cut writes release 1: ledger refs, connection slots, steering marks, payloads outside the manifest', async () => {
    const world = makeWorld();
    const out = await cutRelease({ devProject: devProject(), actorId: 'alice', requestKey: 'rk-1', notes: 'First one' }, world.deps);
    assert.strictEqual(out.reused, false);
    assert.strictEqual(out.release.seq, 1);
    assert.strictEqual(out.release.channel, 'pipeline');
    assert.strictEqual(out.release.gate.blocked, false);
    assert.deepStrictEqual(out.release.gate.findings.map(f => f.code), ['kb.empty']);
    assert.deepStrictEqual([...world.lastConnSlots], [['conn-dev', 'cn_1']]);

    const full = await blueprintStore.getRelease('dev-1', out.release.id);
    assert.strictEqual(full.manifest.channel, 'pipeline');
    assert.strictEqual(full.manifest.solution.slots[0].slot, 'connection:cn_1');
    const steering = Object.fromEntries(full.manifest.solution.variables.map(v => [v.name, v.steering]));
    assert.deepStrictEqual(steering, { api_base: true, region: false, callback: true, approver_team: true },
        'a url variable, a variable in a steering field and a declared one are steering');
    assert.ok(!JSON.stringify(full.manifest).includes('Gold tier'), 'reference rows never ride in the manifest');
    const payloads = await blueprintStore.getReleasePayloads(out.release.id);
    assert.deepStrictEqual(payloads.map(p => [p.ref, p.kind, p.contentHash]), [['dt_1', 'reference_rows', 'rows-v1']]);
    assert.match(full.contentHash, /^sha256:/);
    assert.strictEqual(full.notes.text, 'First one');
    assert.strictEqual(full.notes.requestKey, 'rk-1');
    const ledger = await blueprintStore.refsFor('dev-1');
    assert.deepStrictEqual(ledger.map(r => [r.kind, r.entityId, r.ref]).sort(), [
        ['automations', 'a-1', 'aut_1'], ['connection', 'conn-dev', 'cn_1'], ['datatables', 't-1', 'dt_1'],
    ]);
});

test('an identical cut reuses the latest release; a request key replays; a change cuts release 2 with notes', async () => {
    const world = makeWorld();
    const again = await cutRelease({ devProject: devProject(), actorId: 'alice', requestKey: 'rk-2' }, world.deps);
    assert.strictEqual(again.reused, true);
    assert.strictEqual(again.release.seq, 1);
    const replay = await cutRelease({ devProject: devProject(), actorId: 'alice', requestKey: 'rk-1' }, world.deps);
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.release.seq, 1);

    world.title = 'Invoices v2';
    const next = await cutRelease({ devProject: devProject(), actorId: 'alice', requestKey: 'rk-3' }, world.deps);
    assert.strictEqual(next.release.seq, 2);
    const full = await blueprintStore.getRelease('dev-1', next.release.id);
    assert.deepStrictEqual(full.notes.changes.map(c => [c.entityId, c.change]), [['aut_1', 'changed'], ['dt_1', 'unchanged']]);
    assert.strictEqual(full.notes.basis, 'pipeline');
    // The same definitions with other reference rows is a new release too (D20).
    world.capturePayloads = async ({ refs }) => ({ payloads: [{ ref: refs.get('t-1'), kind: 'reference_rows', sourceEntityId: 't-1', payload: { rows: [] }, contentHash: 'rows-v2' }], findings: [], referenceRefs: [] });
    const rows = await cutRelease({ devProject: devProject(), actorId: 'alice' }, world.deps);
    assert.strictEqual(rows.release.seq, 3);
});

test('409 release_blocked: from the completeness gate, and from a stage-only finding; nothing is written', async () => {
    const world = makeWorld();
    const before = (await blueprintStore.listPipelineReleases('dev-2')).length;
    await assert.rejects(
        cutRelease({ devProject: devProject('dev-2'), actorId: 'alice' }, { ...world.deps, releaseGate: async () => ({ blocked: true, findings: [{ code: 'trigger.missing' }] }) }),
        (e) => e.status === 409 && e.code === 'release_blocked' && e.details.findings[0].code === 'trigger.missing',
    );
    assert.strictEqual(world.captures, 0, 'a blocked gate captures nothing');
    world.captureSolution = async (opts) => {
        const out = await makeWorld().captureSolution(opts);
        return { ...out, rawIds: [{ ref: 'aut_1', path: 'definition.steps[0].code', id: 'a-1' }], findings: [{ code: 'webpage.extra_files', severity: 'blocking', ref: 'web_1' }] };
    };
    await assert.rejects(
        cutRelease({ devProject: devProject('dev-2'), actorId: 'alice' }, world.deps),
        (e) => e.status === 409 && e.code === 'release_blocked'
            && e.details.findings.map(f => f.code).join() === 'webpage.extra_files,release.raw_id_reference',
    );
    assert.strictEqual((await blueprintStore.listPipelineReleases('dev-2')).length, before);
});

test('409 capture_raced after three cuts that never agree', async () => {
    const world = makeWorld();
    world.readCutState = async () => ({ members: { automations: ['a-1'], datatables: ['t-1'] }, connections: [], tokens: { 'automation:a-1': { version: ++world.tokens } } });
    await assert.rejects(
        cutRelease({ devProject: devProject('dev-3'), actorId: 'alice' }, world.deps),
        (e) => e.status === 409 && e.code === 'capture_raced',
    );
    assert.strictEqual(world.captures, 3);
    assert.strictEqual((await blueprintStore.listPipelineReleases('dev-3')).length, 0);
    // A race that settles on the second try cuts.
    let reads = 0;
    world.readCutState = async () => ({ members: { automations: ['a-1'], datatables: ['t-1'] }, connections: ['conn-dev'], tokens: { v: reads++ < 1 ? 'moving' : 'still' } });
    const out = await cutRelease({ devProject: devProject('dev-3'), actorId: 'alice' }, world.deps);
    assert.strictEqual(out.release.seq, 1);
});

test('only the Solution owner cuts, and never on a stage', async () => {
    const world = makeWorld();
    await assert.rejects(cutRelease({ devProject: devProject(), actorId: 'bob' }, world.deps), (e) => e.status === 403 && e.code === 'solution_owner_only');
    await assert.rejects(cutRelease({ devProject: { ...devProject(), stage: 'uat' }, actorId: 'alice' }, world.deps), (e) => e.status === 404);
});

test('releaseVariables and connectionIdsOf', () => {
    assert.deepStrictEqual(releaseVariables([{ name: 'to', type: 'email' }, { name: 'n', type: 'number', required: false }], []), [
        { name: 'to', type: 'email', choices: null, description: '', required: true, steering: true, position: 0 },
        { name: 'n', type: 'number', choices: null, description: '', required: false, steering: false, position: 0 },
    ]);
    assert.deepStrictEqual(connectionIdsOf([
        { steps: [{ id: 'a', type: 'http_request', auth: { connectionId: 'c2' } }, { id: 'b', type: 'http_request', auth: { connectionId: 'c1' } }] },
        { steps: [{ id: 'c', type: 'http_request', auth: { connectionId: 'c2' } }, { id: 'd', type: 'datatable' }] },
    ]), ['c1', 'c2']);
});

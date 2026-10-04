/**
 * PREPARE (design 6.4), with every store and engine injected.
 *
 * Pinned:
 *   - a part the stage does not have is created through install.installOne
 *     with the stage's install context (run-as owner, the stage project, the
 *     org scope, `<key>__<stage>`, no rekey, the deployment's capability), and
 *     journaled pending → done with its new id;
 *   - every write goes to a NON-LIVE slot (the automation's working copy, never
 *     its live copy), with the capability, journaled before it is made with
 *     the versions compensation needs;
 *   - every pointer is resolved to the stage's ids once the parts exist, and
 *     a replaced template's new revision is pinned on its automations;
 *   - a blocking verification fails the deployment (409 prepare_blocked) with
 *     the journal left for compensation; a part that cannot be created fails
 *     it with part_create_failed;
 *   - the stage table key fits the grammar.
 *
 * Run: cd server && node --test projects/stages/prepare.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { prepare, stageTableKey, releaseEntities, stageGrants } = require('./prepare');
const { canonicalOf, hashPayload } = require('./stagePayload');

const STAGE = {
    projectId: 'p_uat', solutionId: 'p_dev', stage: 'uat', organizationId: 'org1', runAsUserId: 'so',
    newPartsActive: true, currentReleaseId: 'rel_1', settingsVersion: 3,
};
const DEPLOYMENT = { id: 'dep_1', releaseId: 'rel_2', kind: 'deploy', fromReleaseId: 'rel_1', stageSettingsVersion: 3 };

const def = (label, extra = {}) => ({ trigger: { type: 'manual' }, steps: [{ id: 's1', type: 'set', values: { label } }], ...extra });

function release(entities) {
    return { id: 'rel_2', seq: 2, channel: 'pipeline', gate: { blocked: false }, manifest: { channel: 'pipeline', solution: { entities, slots: [] } } };
}

/** An in-memory world: stores record what was called with which capability. */
function world({ entities, stamps = [], overrides = {} } = {}) {
    const calls = [];
    const steps = [];
    const automations = new Map([['u-aut-1', { id: 'u-aut-1', kind: 'automation', version: 4, liveVersion: 4, title: 'Old', description: '', definition: def('v1'), isActive: true }]]);
    let nextId = 1;
    const deps = {
        blueprintStore: {
            getRelease: async (solutionId, id) => (id === 'rel_2' ? release(entities) : null),
            listStamps: async () => new Map(stamps.map(s => [s.ref, s])),
            getReleasePayloads: async () => [],
            refsFor: async () => [],
        },
        solutionStageStore: {
            listBindings: async () => [],
            listVariableValues: async () => [],
            getStageFor: async () => null,
            appendStep: async (depId, step) => { const row = { ...step, seq: steps.length + 1 }; steps.push(row); return row; },
            updateStep: async (depId, seq, patch) => { Object.assign(steps[seq - 1], patch); return steps[seq - 1]; },
        },
        install: {
            makeInstallCtx: (opts) => { calls.push(['makeInstallCtx', opts]); return { ...opts, templateVersions: new Map() }; },
            installOne: async (kind, entity, ctx) => {
                calls.push(['installOne', kind, entity.ref]);
                if (entity.ref === 'aut_fail') return null;
                const id = `new-${nextId++}`;
                ctx.refMap.set(entity.ref, id);
                if (kind === 'automation') automations.set(id, { id, kind: 'automation', version: 1, liveVersion: null, title: entity.title, definition: {}, isActive: false });
                return id;
            },
            pinTemplateVersions: require('../packaging/install').pinTemplateVersions,
            skillFieldsOf: () => ({}),
            templateFieldsOf: require('../packaging/install').templateFieldsOf,
        },
        automationStore: {
            getAutomation: async (id) => automations.get(id) || null,
            updateAutomation: async (id, updates, actor, opts) => {
                calls.push(['updateAutomation', id, updates, actor, opts]);
                const a = automations.get(id);
                a.definition = updates.definition;
                a.version += 1;
                return a;
            },
        },
        datatableStore: { orgScope: (id) => ({ kind: 'org', id }), tableFingerprint: () => 'fp' },
        solutionTemplates: {
            createVersionRow: async (id, content, opts) => { calls.push(['createVersionRow', id, opts]); return 'rev-new'; },
        },
        readers: { document: async (id) => ({ id, version_id: 'rev-current' }) },
        checkBeforeLiveCore: async () => ({ ok: true, warnings: [] }),
        aiActState: {},
        scanStagePayloads: async () => [],
        readiness: async () => [],
        stageCompleteness: async () => [],
        ...overrides,
    };
    return { deps, calls, steps, automations };
}

test('a new automation is created through installOne with the stage context, then written to its working copy', async () => {
    const entities = { automations: [{ ref: 'aut_2', kind: 'automation', title: 'New', description: '', definition: def('new') }] };
    const w = world({ entities, plan: { parts: [{ ref: 'aut_2', kind: 'automation', action: 'create', goesLive: true }] } });
    const out = await prepare({ deployment: DEPLOYMENT, stage: STAGE, plan: { parts: [{ ref: 'aut_2', kind: 'automation', action: 'create', goesLive: true }] } }, w.deps);

    const ctx = w.calls.find(c => c[0] === 'makeInstallCtx')[1];
    assert.strictEqual(ctx.ownerId, 'so');
    assert.strictEqual(ctx.projectId, 'p_uat');
    assert.strictEqual(ctx.rekey, false);
    assert.deepStrictEqual(ctx.scope, { kind: 'org', id: 'org1' });
    assert.deepStrictEqual(ctx.managedWrite, { deploymentId: 'dep_1' });
    assert.deepStrictEqual(ctx.dataModelOptions, { managedWrite: { deploymentId: 'dep_1' }, additiveOnly: true });
    assert.strictEqual(ctx.datatableKeyFor({ key: 'prices' }), 'prices__uat');

    const create = w.steps.find(s => s.action === 'create');
    assert.deepStrictEqual([create.status, create.ref, create.entityId], ['done', 'aut_2', 'new-1']);
    const write = w.calls.find(c => c[0] === 'updateAutomation');
    assert.strictEqual(write[1], 'new-1');
    assert.deepStrictEqual(write[4], { managedWrite: { deploymentId: 'dep_1' } });

    const part = out.parts.find(p => p.ref === 'aut_2');
    assert.strictEqual(part.action, 'create');
    assert.strictEqual(part.newOrRevived, true);
    assert.strictEqual(part.hash, hashPayload(canonicalOf('automation', part.entity)));
});

test('a replaced automation: only the working copy moves, journaled with its live version first', async () => {
    const entities = { automations: [{ ref: 'aut_1', kind: 'automation', title: 'Invoices', description: '', definition: def('v2') }] };
    const stamps = [{ ref: 'aut_1', kind: 'automation', entityId: 'u-aut-1', installHash: 'sha256:x', retiredAt: null }];
    const plan = { parts: [{ ref: 'aut_1', kind: 'automation', action: 'replace', goesLive: true }] };
    const w = world({ entities, stamps, plan });
    const liveBefore = w.automations.get('u-aut-1').liveVersion;
    await prepare({ deployment: DEPLOYMENT, stage: STAGE, plan }, w.deps);
    assert.ok(!w.calls.some(c => c[0] === 'installOne'), 'nothing is created');
    const step = w.steps.find(s => s.action === 'write_working');
    assert.strictEqual(step.status, 'done');
    assert.deepStrictEqual(step.before, { version: 4, liveVersion: 4, title: 'Old', description: '' });
    assert.ok(!('definition' in (step.detail || {})), 'the journal holds no content');
    assert.strictEqual(w.automations.get('u-aut-1').liveVersion, liveBefore, 'the live copy did not move');
    assert.deepStrictEqual(w.automations.get('u-aut-1').definition.steps[0].values, { label: 'v2' });
});

test('a pointer at a part created in the same deployment resolves to its new stage id', async () => {
    const entities = {
        datatables: [{ ref: 'dt_1', key: 'prices', name: 'Prices', columns: [{ id: 'f1', key: 'label', type: 'text' }] }],
        automations: [{ ref: 'aut_2', kind: 'automation', title: 'Reads', definition: def('x', { steps: [{ id: 'd', type: 'datatable', op: 'list_rows', datatableId: { $ref: 'dt_1' } }] }) }],
    };
    const plan = { parts: [{ ref: 'dt_1', action: 'create' }, { ref: 'aut_2', action: 'create', goesLive: false }] };
    const w = world({ entities, plan });
    const out = await prepare({ deployment: DEPLOYMENT, stage: STAGE, plan }, w.deps);
    const order = w.calls.filter(c => c[0] === 'installOne').map(c => c[2]);
    assert.deepStrictEqual(order, ['dt_1', 'aut_2'], 'tables first');
    const automation = out.parts.find(p => p.ref === 'aut_2');
    assert.strictEqual(automation.entity.definition.steps[0].datatableId, out.idByRef.get('dt_1'));
    assert.strictEqual(out.tables.length, 1);
    assert.strictEqual(out.tables[0].action, 'create');
});

test('a replaced template gets a new revision, which its automations are pinned to', async () => {
    const entities = {
        documents: [{ ref: 'doc_1', name: 'Invoice', kind: 'template', doc_type: 'document', body_html: '<p>v2</p>' }],
        automations: [{ ref: 'aut_1', kind: 'automation', title: 'Fill', definition: def('x', { steps: [{ id: 'f', type: 'fill_document', documentId: { $ref: 'doc_1' } }] }) }],
    };
    const stamps = [
        { ref: 'doc_1', kind: 'document', entityId: 'u-doc-1', installHash: 'h', retiredAt: null },
        { ref: 'aut_1', kind: 'automation', entityId: 'u-aut-1', installHash: 'h', retiredAt: null },
    ];
    const plan = { parts: [{ ref: 'doc_1', action: 'replace' }, { ref: 'aut_1', action: 'replace', goesLive: false }] };
    const w = world({ entities, stamps, plan });
    const out = await prepare({ deployment: DEPLOYMENT, stage: STAGE, plan }, w.deps);
    const rev = w.calls.find(c => c[0] === 'createVersionRow');
    assert.deepStrictEqual([rev[1], rev[2]], ['u-doc-1', { managedWrite: { deploymentId: 'dep_1' } }]);
    const step = out.parts.find(p => p.ref === 'aut_1').entity.definition.steps[0];
    assert.deepStrictEqual([step.documentId, step.documentVersionId], ['u-doc-1', 'rev-new']);
    assert.deepStrictEqual(out.templates.map(t => t.id), ['u-doc-1'], 'the commit makes it current');
});

test('a blocking verification fails with prepare_blocked and leaves the journal for compensation', async () => {
    const entities = { automations: [{ ref: 'aut_2', kind: 'automation', title: 'New', definition: def('new') }] };
    const plan = { parts: [{ ref: 'aut_2', action: 'create', goesLive: true }] };
    const w = world({ entities, plan, overrides: { checkBeforeLiveCore: async () => ({ ok: false, code: 'ai_act_unclassified' }) } });
    await assert.rejects(prepare({ deployment: DEPLOYMENT, stage: STAGE, plan }, w.deps), (err) => {
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.code, 'prepare_blocked');
        assert.strictEqual(err.message, 'Nothing changed in UAT.');
        assert.deepStrictEqual(err.details.findings.map(f => [f.code, f.ref]), [['ai_act_unclassified', 'aut_2']]);
        return true;
    });
    assert.deepStrictEqual(w.steps.map(s => [s.action, s.status]), [['create', 'done'], ['write_working', 'done']]);
});

test('a part that cannot be created fails the deployment, its pending journal row marked failed', async () => {
    const entities = { automations: [{ ref: 'aut_fail', kind: 'automation', title: 'Broken', definition: def('x') }] };
    const plan = { parts: [{ ref: 'aut_fail', action: 'create' }] };
    const w = world({ entities, plan });
    await assert.rejects(prepare({ deployment: DEPLOYMENT, stage: STAGE, plan }, w.deps), { code: 'part_create_failed' });
    assert.deepStrictEqual(w.steps.map(s => [s.action, s.status]), [['create', 'failed']]);
});

test('a release that is not a pipeline release is refused', async () => {
    const w = world({ entities: {} });
    await assert.rejects(prepare({ deployment: { ...DEPLOYMENT, releaseId: 'nope' }, stage: STAGE, plan: { parts: [] } }, w.deps), { code: 'release_not_found' });
});

test('stageTableKey keeps the stage suffix inside the 63-character grammar', () => {
    assert.strictEqual(stageTableKey('prices', 'prd'), 'prices__prd');
    const long = stageTableKey('x'.repeat(80), 'uat');
    assert.strictEqual(long.length, 63);
    assert.ok(long.endsWith('__uat'));
});

test('releaseEntities names blocks for the installer; stageGrants never carries public columns', () => {
    const map = releaseEntities({ solution: { entities: { automations: [{ ref: 'aut_1', kind: 'block' }], datatables: [{ ref: 'dt_1' }] } } });
    assert.deepStrictEqual([map.get('aut_1').kind, map.get('aut_1').installKind], ['automation', 'block']);
    assert.strictEqual(map.get('dt_1').kind, 'datatable');
    const g = stageGrants({ tables: [{ datatableId: 't1', mode: 'readwrite', publicColumns: ['x'] }], ai: { publicChat: true } });
    assert.deepStrictEqual(g.tables, [{ datatableId: 't1', mode: 'readwrite', columns: [], publicColumns: [] }]);
    assert.ok(!('ai' in g));
});

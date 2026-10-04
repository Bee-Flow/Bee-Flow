/**
 * The deployment plan (design 6.3), with every store and engine injected.
 *
 * One UAT stage that ran release 1 is planned against release 2, which
 * exercises every part action (create, replace, unchanged, retire, revive),
 * drift, a table that retires and unretires columns, a missing binding, an
 * app data model that is not additive and a new automation the AI Act gate
 * refuses. A PRD stage then shows the differences from UAT and its gates.
 *
 * Run: cd server && node --test projects/stages/plan.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { plan, bindReleaseEntity, dataDiff } = require('./plan');
const { canonicalOf, hashPayload } = require('./stagePayload');
const { planHash } = require('./model');
const { additiveModel } = require('../../stores/studioAppDataStore');

const def = (title, extra = {}) => ({ trigger: { type: 'manual' }, steps: [{ id: 's1', type: 'set', values: { t: title } }], ...extra });
const tableModel = (key) => ({ tables: [{ id: 't1', key: 'notes', fields: [{ id: 'f1', key, type: 'text' }] }] });

const RELEASE_2 = {
    id: 'rel_2', seq: 2, channel: 'pipeline', gate: { blocked: false, findings: [] },
    notes: { changes: [{ entityId: 'aut_1', change: 'changed', text: 'Adds a step' }] },
    manifest: {
        channel: 'pipeline',
        solution: {
            entities: {
                automations: [
                    { ref: 'aut_1', kind: 'automation', title: 'Invoices v2', description: '', definition: def('v2', { steps: [{ id: 'd', type: 'datatable', op: 'list_rows', datatableId: { $ref: 'dt_1' } }] }) },
                    { ref: 'aut_2', kind: 'automation', title: 'New one', description: '', definition: def('new', { needsAiAct: true }) },
                    { ref: 'aut_3', kind: 'automation', title: 'Same', description: '', definition: def('same') },
                    { ref: 'aut_4', kind: 'block', title: 'Back again', description: '', definition: def('block') },
                    { ref: 'aut_5', kind: 'automation', title: 'Drifted', description: '', definition: def('drift') },
                    { ref: 'aut_6', kind: 'automation', title: 'Calls an API', description: '', definition: { steps: [{ id: 'h', type: 'http_request', url: 'https://api.x.com', auth: { connectionId: null } }] } },
                ],
                apps: [{ ref: 'app_1', name: 'Desk', definition: { screens: [] }, dataModel: tableModel('subject') }],
                datatables: [{
                    ref: 'dt_1', key: 'prices', name: 'Prices', rowScope: 'all',
                    columns: [{ id: 'fld_a', key: 'label', name: 'Label', type: 'text', required: true }, { id: 'fld_c', key: 'vat', name: 'VAT', type: 'number' }, { id: 'fld_old', key: 'old', name: 'Old', type: 'text' }],
                }],
            },
            slots: [
                { slot: 'connection:cn_1', kind: 'connection', ref: 'aut_6', stepId: 'h', label: 'API connection' },
                { slot: 'seats:aut_1:ok', kind: 'approver_seats', ref: 'aut_1', stepId: 'ok', label: 'Who approves' },
            ],
            variables: [{ name: 'api_base', type: 'url', required: true, steering: true }, { name: 'limit', type: 'number', required: true }],
        },
    },
};

const STORED_APP = { name: 'Desk', definition: { screens: [] }, dataModel: tableModel('title'), isPublished: true };
const STAGE_FIELDS = [{ id: 'fld_a', key: 'label', type: 'text', required: true }, { id: 'fld_b', key: 'region', type: 'text', required: true, unique: true }];
const STAGE_RETIRED = [{ id: 'fld_old', key: '_r_fld_old', fieldKey: 'old', type: 'text', columnType: 'TEXT' }];
const STORED_TABLE = {
    id: 'u-dt-1', key: 'prices__uat', logicalKey: 'prices', name: 'Prices', rowScope: 'all',
    fields: STAGE_FIELDS, retiredFields: STAGE_RETIRED,
    descriptor: { id: 'u-dt-1', key: 'prices__uat', fields: STAGE_FIELDS, retired_fields: STAGE_RETIRED },
};

const STAGE_IDS = { aut_1: 'u-aut-1', aut_3: 'u-aut-3', aut_4: 'u-aut-4', aut_5: 'u-aut-5', aut_6: 'u-aut-6', app_1: 'u-app-1', dt_1: 'u-dt-1', web_9: 'u-web-9' };
const idByRef = new Map(Object.entries(STAGE_IDS));

/** What the commit of release 1 stamped: the bound hash of what it wrote. */
function stampFor(ref, kind, entity, over = {}) {
    const bound = bindReleaseEntity(kind, entity, { idByRef, bindings: new Map(), slots: [] }).entity;
    return { ref, kind: kind === 'block' ? 'automation' : kind, entityId: STAGE_IDS[ref], installHash: hashPayload(canonicalOf(kind, bound)), retiredAt: null, ...over };
}

function uatWorld() {
    const autById = Object.fromEntries(RELEASE_2.manifest.solution.entities.automations.map(a => [a.ref, a]));
    const stamps = new Map([
        ['aut_1', stampFor('aut_1', 'automation', { ...autById.aut_1, title: 'Invoices v1', definition: def('v1') })],
        ['aut_3', stampFor('aut_3', 'automation', autById.aut_3)],
        ['aut_4', stampFor('aut_4', 'automation', autById.aut_4, { retiredAt: '2026-09-01' })],
        ['aut_5', stampFor('aut_5', 'automation', autById.aut_5)],
        ['aut_6', stampFor('aut_6', 'automation', autById.aut_6)],
        // Stamped as they are stored now: no drift on these two.
        ['app_1', { ref: 'app_1', kind: 'app', entityId: 'u-app-1', installHash: hashPayload(canonicalOf('app', STORED_APP)), retiredAt: null }],
        ['dt_1', { ref: 'dt_1', kind: 'datatable', entityId: 'u-dt-1', installHash: hashPayload(canonicalOf('datatable', STORED_TABLE)), retiredAt: null }],
        ['web_9', { ref: 'web_9', kind: 'webpage', entityId: 'u-web-9', installHash: 'sha256:x', retiredAt: null }],
    ]);
    const stored = {
        'u-aut-1': { ...autById.aut_1, title: 'Invoices v1', definition: def('v1'), isActive: true },
        'u-aut-3': { ...autById.aut_3, isActive: false },
        'u-aut-5': { ...autById.aut_5, definition: def('edited by hand'), isActive: true },
        'u-aut-6': { ...autById.aut_6, isActive: false },
    };
    const stage = {
        projectId: 'uat-1', solutionId: 'sol-1', stage: 'uat', organizationId: 'acme', runAsUserId: 'alice',
        newPartsActive: true, requiresApproval: false, currentReleaseId: 'rel_1', currentReleaseSeq: 1, settingsVersion: 4,
    };
    const calls = { goLive: [] };
    const deps = {
        solutionStageStore: {
            getStage: async (id) => (id === 'uat-1' ? stage : null),
            listBindings: async () => [{ slot: 'seats:aut_1:ok', kind: 'approver_seats', value: { assignee: { userId: 'bob' } } }, { slot: 'table:gone', kind: 'table', value: { datatableId: 'x' } }],
            listVariableValues: async () => [{ name: 'api_base', value: 'https://new', appliedValue: 'https://old' }],
            listStages: async () => [{ projectId: 'uat-1', stage: 'uat' }, { projectId: 'prd-1', stage: 'prd' }],
        },
        blueprintStore: {
            getRelease: async (sol, id) => (sol === 'sol-1' && id === 'rel_2' ? RELEASE_2 : null),
            listStamps: async () => stamps,
            getReleasePayloads: async () => [],
            refsFor: async () => [],
        },
        readers: {
            automation: async (id) => stored[id] || null,
            app: async () => STORED_APP,
            datatable: async () => STORED_TABLE,
        },
        datatableStore: { tableFingerprint: (d) => `fp:${d.id}:${d.fields.length}` },
        studioAppDataStore: { additiveModel },
        checkBeforeLiveCore: async ({ automation, definition, ownerId }) => {
            calls.goLive.push([automation.title, ownerId]);
            return definition.needsAiAct
                ? { ok: false, raise: true, status: 409, code: 'ai_act_check_required', message: 'This automation has no AI Act check yet.' }
                : { ok: true, warnings: [] };
        },
        aiActState: async () => ({ required: false }),
        authorizeConnectionUse: async () => ({ ok: true }),
        groupsOf: async () => [],
        providerForTool: () => null,
        ownersOf: async () => new Map(),
        releaseSucceededIn: async () => false,
    };
    return { stage, stamps, deps, calls };
}

const byRef = (list) => Object.fromEntries(list.map(p => [p.ref, p]));

test('create / replace / unchanged / retire / revive, drift and the go-live gate', async () => {
    const { deps, calls } = uatWorld();
    const out = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, deps);
    const parts = byRef(out.parts);
    assert.deepStrictEqual(Object.fromEntries(out.parts.map(p => [p.ref, p.action])), {
        aut_1: 'replace', aut_2: 'create', aut_3: 'unchanged', aut_4: 'revive', aut_5: 'replace', aut_6: 'unchanged',
        app_1: 'replace', dt_1: 'replace', web_9: 'retire',
    });
    assert.strictEqual(parts.aut_5.drift, true, 'the stored automation no longer matches its stamp');
    assert.strictEqual(parts.aut_1.drift, false);
    assert.strictEqual(parts.aut_1.summary, 'Adds a step');
    assert.strictEqual(parts.aut_4.automationKind, 'block');
    assert.strictEqual(parts.aut_2.goesLive, true, 'a new part follows new_parts_active');
    assert.strictEqual(parts.aut_3.goesLive, false, 'an existing part keeps its switch (D22)');
    assert.strictEqual(parts.aut_1.goesLive, true);

    // Go-live checks run for the automations that will be active, as the run-as user.
    assert.deepStrictEqual(calls.goLive.map(c => c[0]).sort(), ['Drifted', 'Invoices v2', 'New one']);
    assert.ok(calls.goLive.every(c => c[1] === 'alice'));
    const codes = out.blocking.map(b => `${b.code}${b.ref ? `@${b.ref}` : ''}`);
    assert.ok(codes.includes('ai_act_check_required@aut_2'), 'an AI-Act-gated automation is blocking');
    assert.ok(codes.includes('app.data_model_not_additive@app_1'), 'a non-additive app model is blocking');
    assert.ok(codes.includes('binding.missing@aut_6'), 'a missing binding is blocking through readiness');
    assert.ok(codes.includes('variable.missing'), 'a required variable without a value');

    assert.deepStrictEqual(out.bindings, {
        missing: [{ slot: 'connection:cn_1', label: 'API connection', neededBy: ['aut_6'] }],
        orphaned: ['table:gone'],
    });
    assert.deepStrictEqual(out.variables, { missing: ['limit'], invalid: [], steeringPending: ['api_base'] });
    assert.deepStrictEqual(out.release, { id: 'rel_2', seq: 2 });
    assert.deepStrictEqual(out.from, { releaseId: 'rel_1', seq: 1 });
    assert.deepStrictEqual(out.gates, { releaseClean: true, testedInUat: null, approval: 'not_required' });
    assert.deepStrictEqual(out.differsFromUat, []);
    assert.strictEqual(out.planHash, planHash(out));
});

test('the table diff: add, retire (constraints relaxed), unretire, fingerprint, retire acknowledgement', async () => {
    const { deps } = uatWorld();
    const out = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, deps);
    assert.deepStrictEqual(out.data, [{
        ref: 'dt_1', name: 'Prices', add: ['vat'], rename: [], unretire: ['old'], blocked: [], preflight: 'pending',
        retire: [{ key: 'region', relaxes: { notNull: true, unique: true, fk: false } }], fingerprint: 'fp:u-dt-1:2',
    }]);
    assert.deepStrictEqual(out.acknowledgementsRequired, [
        { code: 'drift', ref: 'aut_5' },
        { code: 'schema.retire_column', ref: 'dt_1' },
    ]);
    const bound = (await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2', includeBound: true }, deps)).bound;
    const automation = bound.find(b => b.ref === 'aut_1').entity;
    assert.strictEqual(automation.definition.steps[0].datatableId, 'u-dt-1', 'a $ref resolves to the stage table');
    assert.deepStrictEqual(bound.find(b => b.ref === 'dt_1').entity.retiredFields, ['fld_b']);
});

test('the plan hash moves with what the deploy would do', async () => {
    const { deps, stage } = uatWorld();
    const a = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, deps);
    const b = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, deps);
    assert.strictEqual(a.planHash, b.planHash, 'nothing changed, same hash');
    stage.settingsVersion = 5;
    const c = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, deps);
    assert.notStrictEqual(a.planHash, c.planHash);
});

test('a type change in a live column is blocking; a stage table on its first deploy is created', () => {
    const entity = { ref: 'dt_1', name: 'P', columns: [{ id: 'fld_a', key: 'label', type: 'number' }] };
    const { diff } = dataDiff(entity, { fields: [{ id: 'fld_a', key: 'label', type: 'text' }], retiredFields: [] });
    assert.deepStrictEqual(diff.blocked, [{ code: 'schema.type_change', key: 'label' }]);
    assert.strictEqual(dataDiff(entity, null).diff.create, true);
});

test('PRD: differences from UAT, eligibility, approval gate, lawful basis acknowledgement', async () => {
    const { deps, stage } = uatWorld();
    const prd = { ...stage, projectId: 'prd-1', stage: 'prd', newPartsActive: false, requiresApproval: true, approvalPolicy: { stages: [{ key: 's', approvers: [{ userId: 'bob' }] }] } };
    const uatBindings = [{ slot: 'seats:aut_1:ok', kind: 'approver_seats', value: { assignee: { userId: 'uat-tester' } } }];
    const release = JSON.parse(JSON.stringify(RELEASE_2));
    release.manifest.solution.entities.datatables[0].columns.push({ id: 'fld_mail', key: 'email', name: 'Email', type: 'text' });
    const prdDeps = {
        ...deps,
        validateStages: async (s) => s,
        solutionStageStore: {
            ...deps.solutionStageStore,
            getStage: async () => prd,
            getStageFor: async (sol, which) => (which === 'uat' ? { ...stage } : null),
            listBindings: async (id) => (id === 'uat-1' ? uatBindings : [{ slot: 'seats:aut_1:ok', kind: 'approver_seats', value: { assignee: { userId: 'prd-boss' } } }]),
            listVariableValues: async (id) => (id === 'uat-1' ? [{ name: 'limit', value: 5 }] : [{ name: 'limit', value: 50 }, { name: 'api_base', value: 'https://prd', appliedValue: 'https://prd' }]),
        },
        blueprintStore: { ...deps.blueprintStore, getRelease: async () => release },
    };
    const notTested = await plan({ stageProjectId: 'prd-1', releaseId: 'rel_2' }, prdDeps);
    assert.strictEqual(notTested.blocking[0].code, 'release_not_in_uat');
    assert.strictEqual(notTested.gates.testedInUat, false);
    assert.strictEqual(notTested.gates.approval, 'required');

    const tested = await plan({ stageProjectId: 'prd-1', releaseId: 'rel_2' }, { ...prdDeps, releaseSucceededIn: async ({ stage: s }) => s === 'uat' });
    assert.ok(!tested.blocking.some(b => b.code === 'release_not_in_uat'));
    assert.deepStrictEqual(tested.differsFromUat, [
        { kind: 'binding', label: 'seats:aut_1:ok', uat: { assignee: { userId: 'uat-tester' } }, prd: { assignee: { userId: 'prd-boss' } } },
        { kind: 'variable', label: 'api_base', uat: null, prd: 'https://prd' },
        { kind: 'variable', label: 'limit', uat: 5, prd: 50 },
        { kind: 'setting', label: 'newPartsActive', uat: true, prd: false },
    ]);
    assert.ok(tested.acknowledgementsRequired.some(a => a.code === 'privacy.no_lawful_basis' && a.ref === 'dt_1'));
    assert.strictEqual(byRef(tested.parts).aut_2.goesLive, false, 'PRD creates new parts switched off');
});

test('settings and remove plans; unknown stage, release and kind', async () => {
    const { deps, stage } = uatWorld();
    const prd = { ...stage, projectId: 'prd-1', stage: 'prd', requiresApproval: true, approvalPolicy: null };
    const sDeps = { ...deps, solutionStageStore: { ...deps.solutionStageStore, getStage: async () => prd }, validateStages: async (s) => s, groupMemberIds: async () => ({ ids: [] }) };
    const off = await plan({ stageProjectId: 'prd-1', kind: 'settings', settingsPatch: { requiresApproval: false } }, sDeps);
    assert.strictEqual(off.kind, 'settings');
    assert.strictEqual(off.gates.approval, 'required', 'turning the gate off passes the gate (D19)');
    assert.deepStrictEqual(off.blocking, []);
    const ownerOnly = await plan({ stageProjectId: 'prd-1', kind: 'settings', settingsPatch: { approvalPolicy: { stages: [{ key: 's', approvers: [{ userId: 'alice' }] }] } } }, sDeps);
    assert.strictEqual(ownerOnly.blocking[0].code, 'approval_policy_needs_approver');
    assert.notStrictEqual(off.planHash, ownerOnly.planHash);
    await assert.rejects(plan({ stageProjectId: 'prd-1', kind: 'settings', settingsPatch: { enabled: false } }, sDeps), (e) => e.code === 'settings_patch_invalid');

    const remove = await plan({ stageProjectId: 'uat-1', kind: 'remove' }, deps);
    assert.deepStrictEqual(remove.parts.map(p => p.ref), ['app_1', 'aut_1', 'aut_3', 'aut_5', 'aut_6', 'dt_1', 'web_9']);
    assert.strictEqual(remove.deleteData, false);
    assert.deepStrictEqual(remove.acknowledgementsRequired, [{ code: 'stage.remove' }]);
    const wipe = await plan({ stageProjectId: 'uat-1', kind: 'remove', deleteData: true }, deps);
    assert.strictEqual(wipe.deleteData, true);
    assert.deepStrictEqual(wipe.acknowledgementsRequired, [{ code: 'stage.remove' }, { code: 'stage.delete_data' }]);
    assert.notStrictEqual(wipe.planHash, remove.planHash, 'deleteData is in the plan hash');
    assert.strictEqual((await plan({ stageProjectId: 'uat-1', kind: 'remove', deleteData: false }, deps)).planHash, remove.planHash);
    await assert.rejects(plan({ stageProjectId: 'uat-1', kind: 'remove', deleteData: 'yes' }, deps), (e) => e.status === 400 && e.code === 'delete_data_invalid');

    await assert.rejects(plan({ stageProjectId: 'nope', releaseId: 'rel_2' }, deps), (e) => e.status === 404 && e.code === 'stage_not_found');
    await assert.rejects(plan({ stageProjectId: 'uat-1', releaseId: 'rel_x' }, deps), (e) => e.status === 404 && e.code === 'release_not_found');
    await assert.rejects(plan({ stageProjectId: 'uat-1', releaseId: 'rel_2', kind: 'teleport' }, deps), (e) => e.code === 'kind_invalid');
});

test('reference rows and carried knowledge are planned from the release payloads', async () => {
    const { deps, stamps } = uatWorld();
    stamps.set('kb_1', { ref: 'kb_1', kind: 'knowledge_base', entityId: 'u-kb-1', installHash: 'x', retiredAt: null });
    const payloadDeps = {
        ...deps,
        blueprintStore: {
            ...deps.blueprintStore,
            getReleasePayloads: async (releaseId, opts = {}) => {
                if (releaseId === 'rel_1') return opts.kind === 'knowledge_listing' ? [{ ref: 'kb_1', kind: 'knowledge_listing', payload: { docs: [{ contentHash: 'h-gone' }] } }] : [];
                return [
                    { ref: 'dt_1', kind: 'reference_rows', payload: { rows: [{ id: '1', values: { fld_a: 'a' } }, { id: '3', values: { fld_a: 'c' } }] } },
                    { ref: 'kb_1', kind: 'knowledge_listing', payload: { docs: [{ contentHash: 'h1', piiStatus: 'none' }, { contentHash: 'h2', piiStatus: 'found' }] } },
                ];
            },
        },
        readers: { ...deps.readers, reference_rows: async () => ({ rows: [{ id: '1', values: { fld_a: 'a' } }, { id: '2', values: { fld_a: 'b' } }] }) },
        readKbDocs: async () => [{ id: 'd1', content_hash: 'h1', status: 'processed' }, { id: 'd9', content_hash: 'h-gone', status: 'processed' }],
    };
    const out = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, payloadDeps);
    assert.deepStrictEqual(out.referenceRows, [{ ref: 'dt_1', insert: 1, update: 0, delete: 1 }]);
    assert.deepStrictEqual(out.knowledge, [{ ref: 'kb_1', copy: 1, remove: 1, unchanged: 1, personalDataFlagged: 1, sourceStage: 'dev' }]);
    assert.ok(out.acknowledgementsRequired.some(a => a.code === 'kb.personal_data' && a.ref === 'kb_1'));
});

test('the go-live check is deferred for an automation that points at a part this release creates', async () => {
    const { deps, calls } = uatWorld();
    const release = JSON.parse(JSON.stringify(RELEASE_2));
    release.manifest.solution.entities.datatables.push({ ref: 'dt_new', key: 'fresh', name: 'Fresh', rowScope: 'all', columns: [{ id: 'fld_x', key: 'x', name: 'X', type: 'text' }] });
    release.manifest.solution.entities.automations.push(
        { ref: 'aut_7', kind: 'automation', title: 'Uses new table', description: '', definition: { trigger: { type: 'manual' }, steps: [{ id: 'd', type: 'datatable', op: 'list_rows', datatableId: { $ref: 'dt_new' } }] } },
        { ref: 'aut_8', kind: 'automation', title: 'Dangling', description: '', definition: { trigger: { type: 'manual' }, steps: [{ id: 'd', type: 'datatable', op: 'list_rows', datatableId: { $ref: 'dt_gone' } }] } },
    );
    const strict = {
        ...deps,
        blueprintStore: { ...deps.blueprintStore, getRelease: async () => release },
        checkBeforeLiveCore: async ({ automation, definition }) => {
            calls.goLive.push([automation.title, automation.userId]);
            const empty = definition.steps.some(s => s.type === 'datatable' && !s.datatableId);
            return empty
                ? { ok: false, status: 400, code: 'invalid_definition', message: 'Invalid definition', body: { details: [{ code: 'datatable.table_missing', path: 'steps.d' }] } }
                : { ok: true, warnings: [] };
        },
    };
    const out = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, strict);
    const parts = byRef(out.parts);
    assert.strictEqual(parts.aut_7.action, 'create');
    assert.strictEqual(parts.aut_7.goLiveDeferred, true, 'the check waits for prepare, which creates the table first');
    assert.ok(!out.blocking.some(b => b.ref === 'aut_7'), 'no false blocking finding for a table the release brings');
    assert.ok(!calls.goLive.some(c => c[0] === 'Uses new table'));
    // A pointer at something the release does not carry is not deferred: it stays refused, with the details.
    const dangling = out.blocking.find(b => b.ref === 'aut_8');
    assert.strictEqual(dangling.code, 'invalid_definition');
    assert.deepStrictEqual(dangling.details, [{ code: 'datatable.table_missing', path: 'steps.d' }]);
});

test('bindReleaseEntity keeps a JSON-Schema $ref and still resolves bundle refs the registry does not know', () => {
    const ctx = { idByRef: new Map([['aut_1', 'u-aut-1']]), bindings: new Map(), slots: [] };
    const skill = {
        ref: 'skl_1',
        output_schema: { type: 'object', properties: { a: { $ref: '#/$defs/x' } }, $defs: { x: { type: 'string' } } },
        steps: [{ id: 's', refs: [{ id: { $ref: 'aut_1' } }, { id: { $ref: 'doc_9' } }] }],
    };
    const out = bindReleaseEntity('skill', skill, ctx);
    assert.deepStrictEqual(out.entity.output_schema.properties.a, { $ref: '#/$defs/x' });
    assert.deepStrictEqual(out.entity.steps[0].refs, [{ id: 'u-aut-1' }, { id: null }]);
    assert.deepStrictEqual(out.unresolved, ['doc_9']);
});

test('a changed slug or mirror binding makes an otherwise unchanged part a replace', async () => {
    const { deps, stamps } = uatWorld();
    const page = { ref: 'web_1', name: 'Page', files: { html: '<p/>', css: '', js: '' } };
    const table = { ref: 'dt_2', key: 'mirrored', name: 'Mirrored', rowScope: 'all', columns: [{ id: 'fld_m', key: 'm', name: 'M', type: 'text' }] };
    const release = JSON.parse(JSON.stringify(RELEASE_2));
    release.manifest.solution.entities.automations = [];
    release.manifest.solution.entities.apps = [];
    release.manifest.solution.entities.datatables = [table];
    release.manifest.solution.entities.webpages = [page];
    release.manifest.solution.slots = [];
    release.manifest.solution.variables = [];
    const storedPage = { ...page, slug: 'a-uat', isPublished: true };
    const storedTable = { id: 'u-dt-2', key: 'mirrored__uat', logicalKey: 'mirrored', name: 'Mirrored', rowScope: 'all', fields: [{ id: 'fld_m', key: 'm', name: 'M', type: 'text' }], retiredFields: [], source: { kind: 'sheet', id: 'one' }, descriptor: { id: 'u-dt-2', fields: [{ id: 'fld_m', key: 'm', name: 'M', type: 'text' }], retired_fields: [] } };
    stamps.clear();
    stamps.set('web_1', { ref: 'web_1', kind: 'webpage', entityId: 'u-web-1', installHash: hashPayload(canonicalOf('webpage', page)), retiredAt: null });
    stamps.set('dt_2', { ref: 'dt_2', kind: 'datatable', entityId: 'u-dt-2', installHash: hashPayload(canonicalOf('datatable', storedTable)), retiredAt: null });
    const run = async (bindings) => plan({ stageProjectId: 'uat-1', releaseId: 'rel_2' }, {
        ...deps,
        solutionStageStore: { ...deps.solutionStageStore, listBindings: async () => bindings },
        blueprintStore: { ...deps.blueprintStore, getRelease: async () => release },
        readers: { webpage: async () => storedPage, datatable: async () => storedTable },
        slugOwner: async () => null,
    });
    const same = byRef((await run([
        { slot: 'slug:web_1', kind: 'webpage_slug', value: { slug: 'a-uat' } },
        { slot: 'mirror:dt_2', kind: 'mirror_source', value: { kind: 'sheet', id: 'one' } },
    ])).parts);
    assert.deepStrictEqual([same.web_1, same.dt_2].map(p => [p.action, p.drift, p.settingsChanged]), [["unchanged", false, undefined], ["unchanged", false, undefined]]);
    assert.strictEqual(same.dt_2.action, 'unchanged');
    const changed = await run([
        { slot: 'slug:web_1', kind: 'webpage_slug', value: { slug: 'b-uat' } },
        { slot: 'mirror:dt_2', kind: 'mirror_source', value: { kind: 'sheet', id: 'two' } },
    ]);
    const parts = byRef(changed.parts);
    assert.strictEqual(parts.web_1.action, 'replace');
    assert.deepStrictEqual(parts.web_1.settingsChanged, ['slug']);
    assert.strictEqual(parts.dt_2.action, 'replace');
    assert.deepStrictEqual(parts.dt_2.settingsChanged, ['mirror']);
    assert.notStrictEqual(changed.planHash, (await run([])).planHash);
});

test('an automation pinned to an unchanged template reads as unchanged; a changed template leaves it a replace', async () => {
    const TPL = { ref: 'doc_1', name: 'Letter', docType: 'letter', description: '', bodyHtml: '<p>Hi</p>', css: '', settings: {} };
    const fill = (extra = {}) => ({ trigger: { type: 'manual' }, steps: [{ id: 'f', type: 'fill_document', documentId: { $ref: 'doc_1' }, ...extra }] });
    const release = {
        id: 'rel_3', seq: 3, channel: 'pipeline', gate: { blocked: false }, notes: {},
        manifest: { solution: { entities: {
            documents: [TPL],
            automations: [{ ref: 'aut_1', kind: 'automation', title: 'Letters', description: '', definition: fill() }],
        }, slots: [], variables: [] } },
    };
    const storedDoc = { id: 'u-doc-1', version_id: 'ver_9', name: 'Letter', doc_type: 'letter', description: '', body_html: '<p>Hi</p>', css: '', settings: {} };
    const world = (docOver = {}) => {
        const { deps, stage } = uatWorld();
        const ids = new Map([['doc_1', 'u-doc-1'], ['aut_1', 'u-aut-1']]);
        const docShape = { ...storedDoc, ...docOver };
        const docStamp = { ref: 'doc_1', kind: 'document', entityId: 'u-doc-1', retiredAt: null, installHash: hashPayload(canonicalOf('document', storedDoc)) };
        // What prepare stamped: the automation as bound AND pinned to the template's revision.
        const bound = bindReleaseEntity('automation', release.manifest.solution.entities.automations[0], { idByRef: ids, bindings: new Map(), slots: [] }).entity;
        bound.definition.steps[0].documentVersionId = 'ver_9';
        const autStamp = { ref: 'aut_1', kind: 'automation', entityId: 'u-aut-1', retiredAt: null, installHash: hashPayload(canonicalOf('automation', bound)) };
        return {
            stage,
            deps: {
                ...deps,
                blueprintStore: { ...deps.blueprintStore, getRelease: async () => release, listStamps: async () => new Map([['doc_1', docStamp], ['aut_1', autStamp]]) },
                solutionStageStore: { ...deps.solutionStageStore, listBindings: async () => [], listVariableValues: async () => [] },
                readers: { document: async () => docShape, automation: async () => ({ ...bound, isActive: false }) },
                readiness: async () => [],
                scanStagePayloads: async () => [],
            },
        };
    };
    const same = world();
    const out = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_3' }, same.deps);
    const act = Object.fromEntries(out.parts.map(p => [p.ref, p]));
    assert.strictEqual(act.doc_1.action, 'unchanged');
    assert.strictEqual(act.aut_1.action, 'unchanged', 'pinned like prepare pins it, so it is not a replace on every plan');
    assert.strictEqual(act.aut_1.drift, false);
    assert.strictEqual(act.aut_1.documentVersionId, undefined);

    const edited = world({ body_html: '<p>Edited by hand</p>' });
    const out2 = await plan({ stageProjectId: 'uat-1', releaseId: 'rel_3' }, edited.deps);
    const act2 = Object.fromEntries(out2.parts.map(p => [p.ref, p]));
    assert.strictEqual(act2.doc_1.action, 'replace');
    assert.strictEqual(act2.aut_1.action, 'replace', 'the template is rewritten, so the revision the automation pins changes too');
});

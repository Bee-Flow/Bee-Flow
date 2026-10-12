/**
 * The one canonical payload per kind (design 6.3): a bound release entity
 * and the same entity as the stores hand it back must hash the same, for
 * every kind, or every deploy would read as drift. Stores are doubles
 * injected through `deps`; no module mocking.
 *
 * Run: cd server && node --test projects/stages/stagePayload.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalOf, hashPayload, readStagePayload, readStageShape, KIND_OF_SECTION } = require('./stagePayload');
const { canonicalRows, hashReferenceRows } = require('./referenceRows');

const sqlDb = (routes) => ({
    query: async (sql, params) => {
        for (const [re, fn] of routes) if (re.test(sql)) return { rows: fn(params) };
        throw new Error(`unexpected SQL: ${sql}`);
    },
});

const definition = {
    trigger: { type: 'manual' },
    steps: [{ id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_stage0000001' }],
    vars: { region: 'eu' },
};

const CASES = {
    automation: {
        entity: { ref: 'aut_1', kind: 'automation', title: 'Invoices', description: 'Sends them', definition },
        deps: {
            automationStore: {
                getAutomation: async (id) => ({
                    id, kind: 'automation', title: 'Invoices', description: 'Sends them', isActive: true, version: 7,
                    userId: 'alice', definition: { ...definition, manualTriggerPayload: { sample: 1 } },
                }),
            },
        },
    },
    block: {
        kind: 'automation',
        entity: { ref: 'aut_2', kind: 'block', title: 'Step', description: '', definition: { steps: [] } },
        deps: { automationStore: { getAutomation: async (id) => ({ id, kind: 'block', title: 'Step', description: '', definition: { steps: [] } }) } },
    },
    app: {
        entity: {
            ref: 'app_1', name: 'Desk', description: '', icon: null, accentColor: '#f00',
            definition: { screens: [{ id: 'home' }] },
            dataModel: { tables: [{ id: 't1', key: 'notes', fields: [{ id: 'f1', key: 'title', type: 'text' }] }] },
            seedTables: [],
        },
        deps: {
            studioAppStore: {
                getStudioApp: async (id) => ({ id, userId: 'alice', name: 'Desk', description: '', icon: '', accentColor: '#f00', definition: { screens: [{ id: 'home' }] }, isPublished: true }),
            },
            studioAppDataStore: {
                getDataModel: async (id, owner) => {
                    assert.strictEqual(owner, 'alice');
                    return { modelVersion: 3, model: { tables: [{ fields: [{ type: 'text', key: 'title', id: 'f1' }], key: 'notes', id: 't1' }] } };
                },
            },
        },
    },
    webpage: {
        entity: {
            ref: 'web_1', name: 'Prices', description: 'd', instructions: 'i', icon: null, accentColor: null, tagline: null,
            files: { html: '<p>tbl_stage0000001</p>', css: '', js: 'x()' },
            bridgeGrants: {
                automations: [{ automationId: 'aut-stage-1', label: 'Run' }],
                integrations: [{ tool: 'gmail_send', label: 'Mail' }],
                tables: [{ datatableId: 'tbl_stage0000001', mode: 'read', columns: ['b', 'a'], publicColumns: ['a'] }],
                agent: { agentId: 'agt-stage-1' },
            },
            knowledgeBaseIds: ['kb-2', 'kb-1'],
        },
        deps: {
            webpageStore: {
                getWebpageRaw: async (id) => ({ id, userId: 'alice', name: 'Prices', description: 'd', instructions: 'i', icon: '', accentColor: '', tagline: '', publishedVersionId: 'wv_9', knowledgeBaseIds: ['kb-1', 'kb-2'], slug: 'prices-x', isPublished: true }),
                readAllSlots: async (userId, id, versionId) => {
                    assert.strictEqual(versionId, 'wv_9', 'the pinned snapshot, not current/');
                    return { html: '<p>tbl_stage0000001</p>', css: '', js: 'x()' };
                },
                getBridgeGrants: async () => ({
                    ai: { enabled: true, publicEnabled: false },
                    automations: [{ automationId: 'aut-stage-1', label: 'Run' }],
                    integrations: [{ tool: 'gmail_send', label: 'Mail', fixedArgs: { to: 'x' } }],
                    tables: [{ datatableId: 'tbl_stage0000001', mode: 'read', columns: ['a', 'b'], publicColumns: [] }],
                    agent: { agentId: 'agt-stage-1' },
                }),
            },
        },
    },
    datatable: {
        entity: {
            ref: 'dt_1', key: 'prices', name: 'Prices', description: '', rowScope: 'all', lawfulBasis: 'contract',
            columns: [{ id: 'fld_a', key: 'label', name: 'Label', type: 'text', required: true }, { id: 'fld_b', key: 'amount', name: 'Amount', type: 'number' }],
            retiredFields: ['fld_old'],
        },
        deps: {
            db: sqlDb([[/FROM datatables WHERE id/, () => [{ id: 'tbl_stage0000001' }]]]),
            datatableStore: {
                _rowToDatatable: () => ({ id: 'tbl_stage0000001', key: 'prices__uat', logicalKey: 'prices', name: 'Prices', description: '', rowScope: 'all', scope: { kind: 'org', id: 'acme' }, lawfulBasis: null }),
                getTableMeta: async (scope) => {
                    assert.deepStrictEqual(scope, { kind: 'org', id: 'acme' });
                    return {
                        id: 'tbl_stage0000001', key: 'prices__uat', rowsLocked: true,
                        fields: [{ id: 'fld_a', key: 'label', name: 'Label', type: 'text', required: true, unique: false, width: 3 }, { id: 'fld_b', key: 'amount', name: 'Amount', type: 'number' }],
                        retired_fields: [{ id: 'fld_old', key: '_r_fld_old', fieldKey: 'old', notNull: true }],
                    };
                },
            },
        },
    },
    agent: {
        entity: {
            ref: 'agt_1', name: 'Helper', description: '', systemPrompt: 'Be kind', model: 'claude', starterPrompts: ['Hi'],
            threadsEnabled: true, copyEnabled: true, workspaceEnabled: false,
            config: { tools: { gmail: { actions: ['send'], actAs: 'viewer' } }, temperature: 0.2, knowledge_base_ids: ['kb-1'], attachedSkillIds: [] },
            avatar: 'bee.png', persona: { role: 'helper' },
        },
        deps: {
            agentStore: {
                getAgent: async (id) => ({
                    id, name: 'Helper', description: '', system_prompt: 'Be kind', model: 'claude', starter_prompts: ['Hi'],
                    threads_enabled: true, copy_enabled: true, workspace_enabled: false, is_published: true, embed_enabled: true,
                    config: { tools: { gmail: { actions: ['send'], actAs: 'viewer' } }, temperature: 0.2, knowledge_base_ids: ['kb-1'], enabledIntegrations: ['gmail'] },
                    avatar: 'bee.png', persona: { role: 'helper' }, rev: 4,
                }),
            },
        },
    },
    skill: {
        entity: {
            ref: 'skl_1', name: 'Tone', description: '', instructions: 'Short', workflow: '', rules: '', examples: '', icon: '⚡',
            steps: [], rulesV2: [{ text: 'no jargon' }], examplesV2: [], outputSchema: null, dynamicActivation: false,
            knowledgeBaseIds: ['kb-1'], allowedAutomationIds: [], automationId: null,
        },
        deps: {
            db: sqlDb([[/FROM skills WHERE id/, () => [{
                id: 'skill-1', name: 'Tone', description: '', instructions: 'Short', workflow: '', rules: '', examples: '', icon: '⚡',
                steps: [], rules_v2: [{ text: 'no jargon' }], examples_v2: [], output_schema: null, dynamic_activation: false,
                knowledge_base_ids: ['kb-1'], allowed_automation_ids: [], automation_id: null, is_shared: true, version: 3,
            }]]]),
        },
    },
    document: {
        entity: { ref: 'doc_1', name: 'Invoice', doc_type: 'invoice', description: '', body_html: '<h1>{{n}}</h1>', css: 'h1{}', settings: { paper: 'A4' } },
        deps: {
            db: sqlDb([[/FROM studio_documents WHERE id/, () => [{
                id: 'd1', name: 'Invoice', doc_type: 'invoice', description: '', body_html: '<h1>{{n}}</h1>', css: 'h1{}',
                settings: { paper: 'A4', sampleValues: { n: 1 } }, visibility: 'team', folder_id: 'f1',
            }]]]),
        },
    },
    knowledge_base: {
        entity: { ref: 'kb_1', name: 'Policies', description: 'All of them', icon: null, usageContexts: ['chat'] },
        deps: { kbStore: { getKB: async (id) => ({ id, name: 'Policies', description: 'All of them', icon: null, usage_contexts: '["chat"]', is_published: true }) } },
    },
    knowledge_listing: {
        entity: { docs: [{ docRef: 'd1', contentHash: 'h2' }, { docRef: 'd2', contentHash: 'h1' }] },
        deps: { db: sqlDb([[/FROM documents/, () => [{ content_hash: 'h1' }, { content_hash: 'h2' }, { content_hash: 'h2' }]]]) },
    },
};

const DESCRIPTOR = { id: 'tbl_ref0000001', key: 'prices__uat', fields: [{ id: 'fld_label', key: 'label', type: 'text' }, { id: 'fld_n', key: 'n', type: 'number' }] };
const DB_ROWS = [{ id: 2, label: 'b', n: 2 }, { id: 1, label: 'a', n: null }];
CASES.reference_rows = {
    entity: { rows: canonicalRows(DESCRIPTOR, DB_ROWS) },
    deps: {
        db: sqlDb([[/FROM datatables WHERE id/, () => [{ id: DESCRIPTOR.id }]]]),
        datatableStore: { _rowToDatatable: () => ({ id: DESCRIPTOR.id, scope: { kind: 'org', id: 'acme' } }), getTableMeta: async () => DESCRIPTOR },
        readTableRows: async (descriptor) => { assert.strictEqual(descriptor, DESCRIPTOR); return DB_ROWS; },
    },
};

for (const [name, c] of Object.entries(CASES)) {
    test(`round trip: canonicalOf of the bound entity equals readStagePayload of the stored one (${name})`, async () => {
        const kind = c.kind || name;
        const fromRelease = canonicalOf(kind, c.entity);
        const fromStore = await readStagePayload(kind, 'entity-1', {}, c.deps);
        assert.deepStrictEqual(fromStore, fromRelease);
        assert.strictEqual(hashPayload(fromStore), hashPayload(fromRelease));
    });
}

test('a change on the stored side is drift: the hash moves', async () => {
    const c = CASES.automation;
    const changed = {
        automationStore: { getAutomation: async () => ({ kind: 'automation', title: 'Invoices', description: 'Sends them', definition: { ...definition, vars: { region: 'us' } } }) },
    };
    assert.notStrictEqual(
        hashPayload(await readStagePayload('automation', 'a', {}, changed)),
        hashPayload(canonicalOf('automation', c.entity)),
    );
});

test('canonicalOf keeps carried fields only and normalises', () => {
    const page = canonicalOf('webpages', CASES.webpage.entity);
    assert.deepStrictEqual(Object.keys(page.bridgeGrants).sort(), ['agent', 'automations', 'integrations', 'tables']);
    assert.ok(!('publicColumns' in page.bridgeGrants.tables[0]), 'audience is a stage setting');
    assert.deepStrictEqual(page.knowledgeBaseIds, ['kb-1', 'kb-2']);
    const agent = canonicalOf('agent', { config: { tools: { drive: { actions: '*', actAs: 'owner' } } } });
    assert.strictEqual(agent.config.tools.drive.actAs, 'viewer', 'a release never carries owner authority');
    const table = canonicalOf('datatable', CASES.datatable.entity);
    assert.ok(!('lawfulBasis' in table), 'governance is a stage setting after create');
    assert.strictEqual(canonicalOf('reference_rows', { rows: [] }).contentHash, hashReferenceRows([]));
    assert.deepStrictEqual(KIND_OF_SECTION.knowledgeBases, 'knowledge_base');
    assert.throws(() => canonicalOf('nope', {}), /unknown kind/);
});

test('readStagePayload: a gone part is null; a reader can be replaced', async () => {
    assert.strictEqual(await readStagePayload('automation', 'gone', {}, { automationStore: { getAutomation: async () => null } }), null);
    assert.strictEqual(await readStagePayload('automation', '', {}, {}), null);
    const out = await readStagePayload('knowledge_base', 'k', {}, { readers: { knowledge_base: async () => ({ name: 'X' }) } });
    assert.strictEqual(out.name, 'X');
});

test('a template revision is read by its version id', async () => {
    const db = sqlDb([
        [/FROM studio_documents WHERE id/, () => [{ id: 'd1', name: 'Invoice', doc_type: 'invoice', body_html: 'now', css: '' }]],
        [/FROM studio_document_versions/, (p) => (p[0] === 'v1' ? [{ snapshot: { bodyHtml: 'then', css: 'c' } }] : [])],
    ]);
    const out = await readStagePayload('document', 'd1', { versionId: 'v1' }, { db });
    assert.strictEqual(out.bodyHtml, 'then');
    assert.strictEqual(out.css, 'c');
    assert.strictEqual(await readStagePayload('document', 'd1', { versionId: 'v2' }, { db }), null);
});

test('a mirror source is read into the shape but stays outside the canonical payload', async () => {
    const source = { kind: 'sheet', id: 'one' };
    const c = CASES.datatable;
    const deps = {
        ...c.deps,
        datatableStore: { ...c.deps.datatableStore, _rowToDatatable: (...a) => ({ ...c.deps.datatableStore._rowToDatatable(...a), source }) },
    };
    const shape = await readStageShape('datatable', 'entity-1', {}, deps);
    assert.deepStrictEqual(shape.source, source);
    assert.deepStrictEqual(canonicalOf('datatable', shape), canonicalOf('datatable', c.entity));
});

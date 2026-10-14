/**
 * Characterisation of install.js: the golden behaviour pinned before the file
 * was split into install/ (context, provenance, parts per kind, grants, the
 * reference pass). Every store and engine is a recorder (installTestHarness),
 * so what is pinned here is the ORDER an install touches them in, the report it
 * returns and the stamps it writes, for a Blueprint that carries every kind.
 *
 * A change here is a behaviour change, never a refactor.
 *
 * Run: cd server && node --test projects/packaging/install.golden.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { calls, reset, install, AUTOMATION } = require('./installTestHarness');

const EVERY_KIND = () => ({
    datatables: [{ ref: 'tbl_1', key: 'invoices', name: 'Invoices', columns: [{ id: 'c1', key: 'amount', type: 'number' }] }],
    knowledgeBases: [{ ref: 'kb_1', name: 'Handbook', description: 'd', icon: 'book' }],
    documents: [{ ref: 'doc_1', name: 'Letter', doc_type: 'document', kind: 'template', body_html: '<p>x</p>' }],
    automations: [
        AUTOMATION('blk_1', 'block'),
        AUTOMATION('aut_1', 'automation', {
            definition: {
                schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' },
                steps: [{ id: 's1', type: 'action', kind: 'call_block', blockId: { $ref: 'blk_1' } }],
            },
        }),
    ],
    apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: { go: { kind: 'run_automation', automationId: { $ref: 'aut_1' } } } } }],
    webpages: [{
        ref: 'web_1', name: 'Portal', files: { html: '<h1>x</h1>', css: '', js: 'go()' },
        bridgeGrants: {
            automations: [{ automationId: { $ref: 'aut_1' }, label: 'Go' }, { automationId: 'aut_foreign' }],
            integrations: [{ tool: 'gmail_send' }],
            ai: { publicEnabled: true },
        },
    }],
    skills: [{ ref: 'skl_1', name: 'Triage', instructions: 'do it', knowledge_base_ids: [{ $ref: 'kb_1' }] }],
    agents: [{ ref: 'agt_1', name: 'Helper', config: { tools: { t1: { actAs: 'owner' } } } }],
});

const STRIP = (v) => JSON.parse(JSON.stringify(v));

test('GOLDEN: the export surface of install.js', () => {
    assert.deepStrictEqual(Object.keys(require('./install')).sort(), [
        "applyResolutionsTo",
        "collectGrantRequires",
        "createRequestedTables",
        "installAgents",
        "installApps",
        "installAutomations",
        "installBlueprint",
        "installDatatables",
        "installDocumentTemplates",
        "installHashOf",
        "installKnowledgeBases",
        "installOne",
        "installSkills",
        "installWebpages",
        "makeInstallCtx",
        "patchReferences",
        "pinTemplateVersions",
        "provenanceOf",
        "resolveRefs",
        "safeInstallGrants",
        "skillFieldsOf",
        "stampAll",
        "tablesForRebind",
        "templateFieldsOf",
        "verifyClaimedBlueprint"
    ]);
});

test('GOLDEN: a Blueprint with every kind touches the stores in this order', async () => {
    reset();
    const result = await install(EVERY_KIND(), {
        resolutions: { tables: [{ key: 'extra', create: true }] },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls.map(c => c.name), [
        "createProject",
        "createDatatable",
        "createDatatableOpts",
        "assertQuota",
        "applyMigration",
        "invalidate",
        "createKB",
        "setKnowledgeBaseProject",
        "createDocument",
        "membership.setProject",
        "createDatatable",
        "createDatatableOpts",
        "assertQuota",
        "applyMigration",
        "invalidate",
        "createStep",
        "updateAutomation",
        "createAutomation",
        "updateAutomation",
        "createStudioApp",
        "setAppProject",
        "createWebpage",
        "writeSlot",
        "writeSlot",
        "setWebpageProject",
        "createSkill",
        "membership.setProject",
        "createAgent",
        "setAgentProject",
        "saveDefinition",
        "updateAutomation",
        "updateBridgeGrants",
        "upsertBindings",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp",
        "upsertStamp"
    ]);
});

test('GOLDEN: the report and the stamps of that install', async () => {
    reset();
    const result = await install(EVERY_KIND(), {
        resolutions: { tables: [{ key: 'extra', create: true }] },
    });
    assert.deepStrictEqual(STRIP(result), {
        "ok": true,
        "projectId": "proj_new",
        "report": {
            "installed": {
                "automations": [
                    {
                        "ref": "blk_1",
                        "id": "aut_5",
                        "title": "Automation blk_1"
                    },
                    {
                        "ref": "aut_1",
                        "id": "aut_6",
                        "title": "Automation aut_1"
                    }
                ],
                "apps": [
                    {
                        "ref": "app_1",
                        "id": "app_7",
                        "name": "Desk"
                    }
                ],
                "webpages": [
                    {
                        "ref": "web_1",
                        "id": "web_8",
                        "name": "Portal"
                    }
                ],
                "datatables": [
                    {
                        "ref": "tbl_1",
                        "id": "tbl_1",
                        "name": "Invoices"
                    },
                    {
                        "ref": null,
                        "id": "tbl_4",
                        "name": "extra",
                        "forKey": "extra"
                    }
                ],
                "agents": [
                    {
                        "ref": "agt_1",
                        "id": "agt_10",
                        "name": "Helper"
                    }
                ],
                "knowledgeBases": [
                    {
                        "ref": "kb_1",
                        "id": "kb_2",
                        "name": "Handbook"
                    }
                ],
                "skills": [
                    {
                        "ref": "skl_1",
                        "id": "skl_9",
                        "name": "Triage"
                    }
                ],
                "documents": [
                    {
                        "ref": "doc_1",
                        "id": "doc_3",
                        "name": "Letter",
                        "versionId": "ver_of_doc_3"
                    }
                ]
            },
            "computed": {},
            "skipped": [],
            "warnings": [
                "\"Portal\" asks to be allowed to do 3 thing(s) — a tool, an automation elsewhere, or public AI. An install never grants those on your behalf: open the page and grant what it should have."
            ],
            "grantRequires": [
                {
                    "ref": "web_1",
                    "name": "Portal",
                    "kind": "integration",
                    "tool": "gmail_send"
                },
                {
                    "ref": "web_1",
                    "name": "Portal",
                    "kind": "automation",
                    "automationId": "aut_foreign"
                },
                {
                    "ref": "web_1",
                    "name": "Portal",
                    "kind": "public_ai",
                    "flags": {
                        "publicEnabled": true
                    }
                }
            ],
            "resolved": []
        }
    });
    const stamps = calls.filter(c => c.name === 'upsertStamp')
        .map(c => ({ ref: c.args.ref, kind: c.args.kind, entityId: c.args.entityId, installedVersion: c.args.installedVersion }));
    assert.deepStrictEqual(stamps, [
        {
            "ref": "tbl_1",
            "kind": "datatable",
            "entityId": "tbl_1",
            "installedVersion": 1
        },
        {
            "ref": "kb_1",
            "kind": "knowledge_base",
            "entityId": "kb_2",
            "installedVersion": 1
        },
        {
            "ref": "doc_1",
            "kind": "document",
            "entityId": "doc_3",
            "installedVersion": 1
        },
        {
            "ref": "blk_1",
            "kind": "automation",
            "entityId": "aut_5",
            "installedVersion": 1
        },
        {
            "ref": "aut_1",
            "kind": "automation",
            "entityId": "aut_6",
            "installedVersion": 1
        },
        {
            "ref": "app_1",
            "kind": "app",
            "entityId": "app_7",
            "installedVersion": 1
        },
        {
            "ref": "web_1",
            "kind": "webpage",
            "entityId": "web_8",
            "installedVersion": 1
        },
        {
            "ref": "skl_1",
            "kind": "skill",
            "entityId": "skl_9",
            "installedVersion": 1
        },
        {
            "ref": "agt_1",
            "kind": "agent",
            "entityId": "agt_10",
            "installedVersion": 1
        }
    ]);
});

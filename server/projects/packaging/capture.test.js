/**
 * Capturing a live Solution as a Blueprint.
 *
 * The end-to-end assertion that matters is the ORDERING: in-bundle pointers are
 * rewritten to `$ref` first and survive the trip, and only what could not be
 * resolved locally is nulled by the scrub and reported as a dependency. Reverse
 * those two and every Blueprint installs inert — an app that no longer knows
 * which routine it runs — which is the exact failure every other packaging path
 * in this product accepts and this one exists to avoid.
 *
 * The other half is that nothing which must not leave an installation does:
 * credentials, approver seats, a webpage's live database, an integration
 * grant's saved arguments.
 *
 * Run: cd server && node --test projects/packaging/capture.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Store stubs, seeded before capture.js resolves them ─────────────────────
const automationStorePath = require.resolve('../../stores/automationStore');
const studioAppStorePath = require.resolve('../../stores/studioAppStore');
const webpageStorePath = require.resolve('../../stores/webpageStore');
const datatableStorePath = require.resolve('../../stores/datatableStore');
const agentStorePath = require.resolve('../../stores/agentStore');
const knowledgeBasesPath = require.resolve('../../stores/knowledgeBases');
const projectStorePath = require.resolve('../../stores/projectStore');
const notebookStorePath = require.resolve('../../stores/notebookStore');

const fx = {
    automations: [], apps: [], webpages: [], extraFiles: [],
    datatables: [], tableMeta: {}, agents: [], knowledgeBases: [],
    // Notebooks are COUNTED, not captured: a Blueprint does not carry them, and
    // the count exists only so the capture can say so. `null` makes the count
    // itself fail, which is a third answer and not the same as zero.
    notebookCount: 0,
};

require.cache[automationStorePath] = {
    id: automationStorePath, filename: automationStorePath, loaded: true,
    exports: { getAutomationsForProject: async () => fx.automations },
};
require.cache[studioAppStorePath] = {
    id: studioAppStorePath, filename: studioAppStorePath, loaded: true,
    exports: {
        listProjectApps: async () => fx.apps.map(a => ({ id: a.id })),
        getStudioApp: async (id) => fx.apps.find(a => a.id === id) || null,
    },
};
require.cache[webpageStorePath] = {
    id: webpageStorePath, filename: webpageStorePath, loaded: true,
    exports: {
        listProjectWebpages: async () => fx.webpages,
        readAllSlots: async () => ({ html: '<h1>Hi</h1>', css: 'body{}', js: 'console.log(1)' }),
        listExtraFiles: async () => fx.extraFiles,
    },
};

require.cache[datatableStorePath] = {
    id: datatableStorePath, filename: datatableStorePath, loaded: true,
    exports: {
        listDatatablesForProject: async () => fx.datatables,
        getTableMeta: async (_scope, id) => fx.tableMeta[id] || null,
    },
};
require.cache[agentStorePath] = {
    id: agentStorePath, filename: agentStorePath, loaded: true,
    exports: {
        listProjectAgents: async () => fx.agents.map(a => ({ id: a.id })),
        getAgent: async (id) => fx.agents.find(a => a.id === id) || null,
    },
};
require.cache[notebookStorePath] = {
    id: notebookStorePath, filename: notebookStorePath, loaded: true,
    exports: {
        countProjectNotebooks: async (ids) => {
            if (fx.notebookCount === null) throw new Error('notebooks unavailable');
            return new Map((ids || []).map(id => [id, fx.notebookCount]));
        },
    },
};
require.cache[knowledgeBasesPath] = {
    id: knowledgeBasesPath, filename: knowledgeBasesPath, loaded: true,
    exports: { getKB: async (id) => fx.knowledgeBases.find(k => k.id === id) || null },
};
// The knowledge-base adapter reads the project row for its id list, so the
// project store is seeded too — the base rows themselves come from the stub
// above, exactly as they would in production.
require.cache[projectStorePath] = {
    id: projectStorePath, filename: projectStorePath, loaded: true,
    exports: {
        getProject: async (id) => ({ id, name: 'Onboarding', organizationId: 'org1', version: 1, knowledgeBaseIds: fx.knowledgeBases.map(k => k.id) }),
    },
};

const { captureSolution } = require('./capture');
const { sanitizeManifest } = require('./manifest');

const PROJECT = { id: 'p1', name: 'Onboarding', description: 'How we onboard', icon: '📁', color: '#fff', customInstructions: 'be brief' };

function reset() {
    fx.automations = [];
    fx.apps = [];
    fx.webpages = [];
    fx.extraFiles = [];
    fx.datatables = [];
    fx.tableMeta = {};
    fx.agents = [];
    fx.knowledgeBases = [];
}

const capture = () => captureSolution({ project: PROJECT, exportedAt: '2026-08-23T00:00:00Z' });

// ═══ The ordering that makes a Blueprint arrive wired ════════════════

test('an in-bundle routine reference survives as a $ref', async () => {
    reset();
    fx.automations = [{
        id: 'aut_live', title: 'Nightly', userId: 'alice', kind: 'automation',
        definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [] },
    }];
    fx.apps = [{
        id: 'app_live', name: 'Desk', userId: 'alice',
        definition: { actions: { go: { kind: 'run_automation', automationId: 'aut_live' } } },
    }];

    const { manifest } = await capture();
    const app = manifest.solution.entities.apps[0];
    assert.deepStrictEqual(app.definition.actions.go.automationId, { $ref: 'aut_1' });
    assert.ok(!JSON.stringify(manifest).includes('aut_live'), 'the real id never travels');
});

test('an OUT-of-bundle reference is nulled and reported as a dependency', async () => {
    reset();
    fx.apps = [{
        id: 'app_live', name: 'Desk', userId: 'alice',
        definition: { actions: { go: { kind: 'run_automation', automationId: 'aut_elsewhere' } } },
    }];

    const { manifest } = await capture();
    assert.strictEqual(manifest.solution.entities.apps[0].definition.actions.go.automationId, null);
    assert.ok(manifest.solution.report.warnings.some(w => /has to connect them/.test(w)));
    assert.ok(manifest.solution.requires.some(r => r.kind === 'automation'), 'named in requires, never guessed');
});

test('the captured Blueprint is self-consistent', async () => {
    reset();
    fx.automations = [{ id: 'a1', title: 'Nightly', userId: 'alice', kind: 'automation', definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [] } }];
    fx.apps = [{ id: 'app1', name: 'Desk', userId: 'alice', definition: { actions: { go: { kind: 'run_automation', automationId: 'a1' } } } }];

    const { manifest } = await capture();
    // Every $ref resolves to an entity the file actually carries.
    assert.strictEqual(sanitizeManifest(manifest).ok, true);
});

// ═══ What must never leave ═══════════════════════════════════════════

test('approver seats do not travel, from either shape', async () => {
    reset();
    fx.automations = [{
        id: 'a1', title: 'Release', userId: 'alice', kind: 'automation',
        definition: {
            schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' },
            steps: [{ id: 's1', type: 'approval', prompt: 'Ship it?', approval: { assignee: { userId: 'usr_carol' }, expiresInHours: 24 } }],
        },
    }];
    fx.apps = [{
        id: 'app1', name: 'Desk', userId: 'alice',
        definition: { actions: { ask: { kind: 'request_approval', prompt: 'ok?', approverGroupIds: ['grp_finance'] } } },
    }];

    const { manifest } = await capture();
    const wire = JSON.stringify(manifest);
    assert.ok(!wire.includes('usr_carol'));
    assert.ok(!wire.includes('grp_finance'));
    // The policy stays — a deadline is not a person.
    assert.strictEqual(manifest.solution.entities.automations[0].definition.steps[0].approval.expiresInHours, 24);
    assert.ok(manifest.solution.requires.some(r => r.kind === 'approver'), 'the installer is told to name approvers');
});

test('a saved credential does not travel', async () => {
    reset();
    fx.automations = [{
        id: 'a1', title: 'Fetch', userId: 'alice', kind: 'automation',
        definition: {
            schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' },
            steps: [{ id: 's1', type: 'http_request', auth: { connectionId: 'conn_live', kind: 'bearer' } }],
        },
    }];
    const { manifest } = await capture();
    assert.ok(!JSON.stringify(manifest).includes('conn_live'));
});

test('a webpage grant keeps the tool name and drops its saved arguments', async () => {
    reset();
    fx.webpages = [{
        id: 'w1', name: 'Status', userId: 'alice',
        bridgeGrants: {
            ai: { enabled: true },
            automations: [],
            integrations: [{ tool: 'nextcloud_upload_file', label: 'Upload', fixedArgs: { path: '/secret/internal/path', token: 'LEAK-CANARY' } }],
        },
    }];
    const { manifest } = await capture();
    const grants = manifest.solution.entities.webpages[0].bridgeGrants;
    assert.strictEqual(grants.integrations[0].tool, 'nextcloud_upload_file', 'the installer is told what to re-authorise');
    assert.strictEqual(grants.integrations[0].fixedArgs, undefined);
    assert.ok(!JSON.stringify(manifest).includes('LEAK-CANARY'));
});

test('a webpage database is never exported, and the report says so', async () => {
    reset();
    fx.webpages = [{ id: 'w1', name: 'Status', userId: 'alice', dbSize: 40960, bridgeGrants: {} }];
    const { manifest } = await capture();
    assert.ok(manifest.solution.report.warnings.some(w => /holds live data and is never exported/.test(w)));
});

test('extra webpage files are reported rather than silently dropped', async () => {
    reset();
    fx.webpages = [{ id: 'w1', name: 'Status', userId: 'alice', bridgeGrants: {} }];
    fx.extraFiles = [{ path: 'a.png' }, { path: 'b.json' }];
    const { manifest } = await capture();
    assert.ok(manifest.solution.report.warnings.some(w => /2 additional file\(s\)/.test(w)),
        'a silent truncation reads as "we carried everything"');
});

test('app table data is opt-in, and nothing is opted in', async () => {
    reset();
    fx.apps = [{ id: 'app1', name: 'Desk', userId: 'alice', definition: {} }];
    const { manifest } = await capture();
    assert.deepStrictEqual(manifest.solution.entities.apps[0].seedTables, []);
});

// ═══ Shape ═══════════════════════════════════════════════════════════

test('an empty project still produces a valid, honest Blueprint', async () => {
    reset();
    const { manifest } = await capture();
    assert.strictEqual(sanitizeManifest(manifest).ok, true);
    assert.deepStrictEqual(manifest.solution.report.counts, {
        automations: 0, apps: 0, webpages: 0, datatables: 0, agents: 0, knowledgeBases: 0,
    });
    assert.strictEqual(manifest.solution.name, 'Onboarding');
});

test('a project that could not be read is refused, not half-captured', async () => {
    const result = await captureSolution({ project: null });
    assert.strictEqual(result.ok, false);
});

// ═══ The three kinds that travel as a SHAPE ══════════════════════════
//
// A table, an agent and a knowledge base are ROWS, and a row grows columns. So
// each is rebuilt from an allow-list and every assertion below is written as a
// LEAK CANARY: a value that must not appear anywhere in the file, whatever key
// it happened to sit under.

test('a table travels as columns — never a row, never a grant', async () => {
    reset();
    fx.datatables = [{
        id: 'tbl_live', key: 'invoices', name: 'Invoices', description: 'what we billed',
        scope: { kind: 'org', id: 'org1' }, scopeKind: 'org', organizationId: 'org1',
        ownerUserId: 'usr_alice', isPublished: true, sharedGroups: ['grp_finance'],
        writeMode: 'grants', lawfulBasis: 'LEAK-CANARY-BASIS', rowScope: 'all',
        retentionDays: 90, retentionField: 'created_at', subjectColumn: 'email',
        rowCount: 4200, dataVersion: 12,
    }];
    fx.tableMeta = {
        tbl_live: { id: 'tbl_live', key: 'invoices', fields: [
            { id: 'fld_abc123', key: 'amount', name: 'Amount', type: 'number', required: true },
            { id: 'fld_def456', key: 'status', name: 'Status', type: 'select', options: ['open', 'paid'] },
        ] },
    };

    const { manifest } = await capture();
    const table = manifest.solution.entities.datatables[0];

    assert.deepStrictEqual(table.columns, [
        { key: 'amount', name: 'Amount', type: 'number', required: true },
        { key: 'status', name: 'Status', type: 'select', options: ['open', 'paid'] },
    ], 'the shape travels, and the per-install column ids do not');
    // The retention window travels because it PROTECTS the recipient's data.
    assert.strictEqual(table.retentionDays, 90);

    const wire = JSON.stringify(manifest);
    assert.ok(!wire.includes('LEAK-CANARY-BASIS'), 'a lawful basis is one controller\'s legal claim');
    assert.ok(!wire.includes('usr_alice'), 'nor the owner');
    assert.ok(!wire.includes('grp_finance'), 'nor who it is shared with');
    assert.ok(!wire.includes('tbl_live'), 'nor the real id');
    assert.ok(!wire.includes('org1'), 'nor the tenant');
    assert.strictEqual(table.rowCount, undefined, 'and not one row, nor a count of them');
    assert.strictEqual(table.isPublished, undefined);
});

test('a column key nobody put on the allow-list does not travel', async () => {
    reset();
    fx.datatables = [{ id: 'tbl_live', key: 't', name: 'T', description: 'd', scope: { kind: 'org', id: 'org1' } }];
    fx.tableMeta = {
        tbl_live: { fields: [{ id: 'fld_a', key: 'x', name: 'X', type: 'text', secretHint: 'LEAK-CANARY-COLUMN' }] },
    };
    const { manifest } = await capture();
    assert.ok(!JSON.stringify(manifest).includes('LEAK-CANARY-COLUMN'),
        'a field added to the column shape next year must not travel by default');
});

test('a table with unreadable columns is reported, not silently emptied', async () => {
    reset();
    fx.datatables = [{ id: 'tbl_live', key: 't', name: 'Orders', description: 'd', scope: { kind: 'org', id: 'org1' } }];
    fx.tableMeta = {};
    const { manifest } = await capture();
    assert.deepStrictEqual(manifest.solution.entities.datatables[0].columns, []);
    assert.ok(manifest.solution.report.warnings.some(w => /Could not read the columns of "Orders"/.test(w)));
});

test('an agent arrives able to act as the person using it, and never as its author', async () => {
    reset();
    fx.agents = [{
        id: 'ag_live', name: 'Desk agent', description: 'helps', system_prompt: 'be brief',
        model: 'tier:fast', starter_prompts: ['hi'],
        threads_enabled: true, copy_enabled: true, workspace_enabled: false,
        embed_enabled: true,
        owner_id: 'usr_alice', organization_id: 'org1', category_id: 'cat_x',
        is_published: true, shared_groups: ['grp_sales'], rev: 7,
        published_version: 3, published_at: '2026-01-01',
        config: {
            tools: { gmail: { actions: '*', actAs: 'owner', confirm: 'direct' } },
            enabledIntegrations: ['gmail'],
            knowledge_base_ids: ['kb_secret'],
            attachedSkillIds: ['skl_secret'],
            memoryEnabled: true,
            somethingNobodyReviewed: 'LEAK-CANARY-CONFIG',
        },
    }];

    const { manifest } = await capture();
    const agent = manifest.solution.entities.agents[0];

    // THE rights proof: the strongest grant in the source becomes the weakest
    // one the format can express.
    assert.strictEqual(agent.config.tools.gmail.actAs, 'viewer');
    assert.strictEqual(agent.config.tools.gmail.actions, '*', 'which actions is still the author\'s design');
    assert.strictEqual(agent.embed_enabled, undefined, 'an installed agent is not embeddable on arrival');
    assert.strictEqual(agent.embedEnabled, undefined);
    assert.strictEqual(agent.config.enabledIntegrations, undefined, 'a connected app is a requirement, not a grant');
    assert.strictEqual(agent.config.knowledge_base_ids, undefined);
    assert.strictEqual(agent.config.attachedSkillIds, undefined);
    assert.strictEqual(agent.config.memoryEnabled, true, 'a behaviour setting is the author\'s work and travels');

    const wire = JSON.stringify(manifest);
    for (const canary of ['LEAK-CANARY-CONFIG', 'usr_alice', 'org1', 'cat_x', 'grp_sales', 'kb_secret', 'skl_secret', 'ag_live']) {
        assert.ok(!wire.includes(canary), `${canary} must not travel`);
    }

    // Both halves of the requirement: the app it may reach is named as an EIS.
    assert.ok(manifest.solution.requires.some(r => r.kind === 'integration' && r.count === 1),
        'the installer is told to connect it, rather than finding it already connected');
    assert.ok(manifest.solution.report.warnings.some(w => /acting as its owner/.test(w)));
});

test('an agent with no tools and no integrations asks for nothing', async () => {
    reset();
    fx.agents = [{ id: 'ag1', name: 'Plain', config: {} }];
    const { manifest } = await capture();
    assert.ok(!manifest.solution.requires.some(r => r.kind === 'integration'));
});

test('a knowledge base travels as a shell, and its documents stay here', async () => {
    reset();
    fx.knowledgeBases = [{
        id: 'kb_live', name: 'Handbook', description: 'how we work', icon: '📘',
        usage_contexts: ['chat', 'agent'],
        tenant_id: 'usr_alice', organization_id: 'org1', category_id: 'cat_x',
        is_published: true, shared_groups: ['grp_hr'],
        documentCount: 412, lastIngestedAt: 'LEAK-CANARY-KB',
    }];

    const { manifest } = await capture();
    const kb = manifest.solution.entities.knowledgeBases[0];

    assert.deepStrictEqual(Object.keys(kb).sort(), ['description', 'icon', 'name', 'ref', 'usageContexts']);
    assert.deepStrictEqual(kb.usageContexts, ['chat', 'agent'], 'where it may be used is a limit, and limits travel');
    const wire = JSON.stringify(manifest);
    for (const canary of ['LEAK-CANARY-KB', 'usr_alice', 'org1', 'cat_x', 'grp_hr', 'kb_live']) {
        assert.ok(!wire.includes(canary), `${canary} must not travel`);
    }
    assert.ok(manifest.solution.report.warnings.some(w => /travels as an empty knowledge base/.test(w)));
});

// ═══ The public-AI leak, from both ends ══════════════════════════════

test('NO ai.public key survives a capture — including one invented later', async () => {
    // The rule is written by SHAPE, not by a list of names, so a field
    // bridgeGrants gains next year is covered by the rule that predates it.
    reset();
    fx.webpages = [{
        id: 'w1', name: 'Status', userId: 'alice',
        bridgeGrants: {
            ai: {
                enabled: true, publicEnabled: true, publicSpendCapUsd: 50,
                publicDefaultTier: 'deep', public_iets_nieuws: 'LEAK-CANARY-AI',
            },
            automations: [], integrations: [],
        },
    }];
    const { manifest } = await capture();
    const grants = manifest.solution.entities.webpages[0].bridgeGrants;

    assert.strictEqual(grants.ai, undefined, 'the whole block goes; install writes the store default');
    assert.ok(!JSON.stringify(manifest).includes('LEAK-CANARY-AI'));
    assert.ok(!JSON.stringify(manifest).includes('publicEnabled'));
    assert.ok(manifest.solution.report.warnings.some(w => /Public AI for anonymous visitors is off on arrival/.test(w)));
});

test('a webpage automation grant carries no key nobody reviewed', async () => {
    reset();
    fx.webpages = [{
        id: 'w1', name: 'Status', userId: 'alice',
        bridgeGrants: { automations: [{ automationId: 'aut_elsewhere', label: 'Run', seat: 'LEAK-CANARY-GRANT' }] },
    }];
    const { manifest } = await capture();
    const grant = manifest.solution.entities.webpages[0].bridgeGrants.automations[0];
    assert.deepStrictEqual(grant, { automationId: null, label: 'Run' },
        'the spread this replaced carried every other key a grant had');
    assert.ok(!JSON.stringify(manifest).includes('LEAK-CANARY-GRANT'));
});

test('an in-bundle webpage grant still survives as a $ref', async () => {
    // The allow-list must not undo the rewrite: this is the whole reason a
    // Blueprint arrives wired instead of inert.
    reset();
    fx.automations = [{
        id: 'aut_live', title: 'Nightly', userId: 'alice', kind: 'automation',
        definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [] },
    }];
    fx.webpages = [{
        id: 'w1', name: 'Status', userId: 'alice',
        bridgeGrants: { automations: [{ automationId: 'aut_live', label: 'Run' }] },
    }];
    const { manifest } = await capture();
    assert.deepStrictEqual(
        manifest.solution.entities.webpages[0].bridgeGrants.automations[0],
        { automationId: { $ref: 'aut_1' }, label: 'Run' },
    );
});

test('a dependency is counted under its OWN kind', async () => {
    // "needs 3 automation(s)" for three missing knowledge bases sends whoever
    // installs it to the wrong screen.
    reset();
    fx.agents = [{ id: 'ag1', name: 'A', config: { knowledge_base_ids: ['kb_elsewhere'], attachedSkillIds: ['skl_1'] } }];
    const { manifest } = await capture();
    const kinds = manifest.solution.requires.map(r => r.kind).sort();
    assert.ok(kinds.includes('knowledge_base'), 'a missing base is named as a base');
    assert.ok(kinds.includes('skill'), 'and a skill as a skill');
    assert.ok(!kinds.includes('automation'), 'and neither is called a routine');
});

test('not one real id of this installation appears anywhere in the file', async () => {
    // The payload was always careful — positional $refs exist for exactly this
    // — and the REPORT beside it was not: node ids, target ids and the prose
    // that quoted them carried this install's routine, app and (once agents
    // could depend on them) knowledge-base ids into every exported file.
    reset();
    fx.automations = [{
        id: 'aut_REAL', title: 'Nightly', userId: 'alice', kind: 'automation',
        definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [] },
    }];
    fx.apps = [{
        id: 'app_REAL', name: 'Desk', userId: 'alice',
        definition: { actions: { go: { kind: 'run_automation', automationId: 'aut_GONE' } } },
    }];
    fx.webpages = [{ id: 'web_REAL', name: 'Status', userId: 'alice', bridgeGrants: {} }];
    fx.datatables = [{ id: 'tbl_REAL', key: 't', name: 'T', description: 'd', scope: { kind: 'org', id: 'org1' } }];
    fx.agents = [{ id: 'agt_REAL', name: 'A', config: { knowledge_base_ids: ['kb_GONE'], attachedSkillIds: ['skl_GONE'] } }];
    fx.knowledgeBases = [{ id: 'kb_REAL', name: 'Handbook' }];

    const wire = JSON.stringify(await capture());
    for (const id of ['aut_REAL', 'app_REAL', 'web_REAL', 'tbl_REAL', 'agt_REAL', 'kb_REAL']) {
        assert.ok(!wire.includes(id), `${id}: a bundled entity travels as a $ref, never as itself`);
    }
    for (const id of ['aut_GONE', 'kb_GONE', 'skl_GONE']) {
        assert.ok(!wire.includes(id), `${id}: an id we could not resolve is not ours to publish either`);
    }
});

test('a problem still says WHAT is wrong and WHICH bundled entity holds it', async () => {
    // Redaction must not turn the report into nothing: the installer still has
    // to be able to act on it.
    reset();
    fx.apps = [{
        id: 'app_REAL', name: 'Desk', userId: 'alice',
        definition: { actions: { go: { kind: 'run_automation', automationId: null } } },
    }];
    const { manifest } = await capture();
    const problem = manifest.solution.report.problems[0];
    assert.strictEqual(problem.code, 'unwired');
    assert.strictEqual(problem.severity, 'warning');
    assert.strictEqual(problem.ref, 'app_1', 'named by its bundle ref, the only name a Blueprint may use');
    assert.match(problem.message, /never got a routine picked/);
});

test('externals travel as a count per kind, not as a list of ids', async () => {
    reset();
    fx.apps = [{
        id: 'app1', name: 'Desk', userId: 'alice',
        definition: { actions: { go: { kind: 'run_automation', automationId: 'aut_elsewhere' } } },
    }];
    const { manifest } = await capture();
    assert.deepStrictEqual(manifest.solution.report.externals, [{ kind: 'automation', count: 1 }]);
});

// ── What a Blueprint does NOT carry, said out loud ───────────────────
//
// The membership registry knows eight member kinds; the packager reads six.
// Approvals are the deliberate omission and manifest.js says why — a past
// decision belongs to the organisation that took it. Notebooks were simply
// forgotten, and the cost of that was silence: a Solution with notes was
// captured, installed elsewhere, and arrived without them, with nothing on
// either side saying so.
//
// Carrying notebooks is a manifest change and belongs to O4. Saying they do
// not travel belongs here, in the same channel that already tells the person
// capturing which routines they will have to reconnect by hand.

test('a Solution with notebooks says they are not coming along', async () => {
    fx.notebookCount = 3;
    const out = await captureSolution({ project: PROJECT, exportedAt: '2026-08-23T00:00:00Z' });
    assert.ok(out.ok);
    const said = (out.manifest.solution.report.warnings || []).find(w => /notebook/i.test(w));
    assert.ok(said, 'the capture must mention notebooks it is leaving behind');
    assert.match(said, /3/, 'and say how many, so the person can weigh it');
    assert.match(said, /NOT included|not included/, 'and be unambiguous that they do not travel');
});

test('a Solution without notebooks says nothing — no warning for a non-problem', async () => {
    fx.notebookCount = 0;
    const out = await captureSolution({ project: PROJECT, exportedAt: '2026-08-23T00:00:00Z' });
    assert.ok(out.ok);
    assert.ok(!(out.manifest.solution.report.warnings || []).some(w => /notebook/i.test(w)),
        'warning fatigue is real: nothing was left behind, so nothing is said');
});

test('a count that could not be read is its own answer, not zero', async () => {
    // The third state. "No notebooks" and "I could not check" must not collapse
    // into the same silence — the second one still means notes may be lost.
    fx.notebookCount = null;
    const out = await captureSolution({ project: PROJECT, exportedAt: '2026-08-23T00:00:00Z' });
    assert.ok(out.ok, 'an unreadable count must not fail the whole capture');
    const said = (out.manifest.solution.report.warnings || []).find(w => /notebook/i.test(w));
    assert.ok(said, 'an unreadable count is still worth saying');
    assert.match(said, /Could not check/i);
    fx.notebookCount = 0;
});

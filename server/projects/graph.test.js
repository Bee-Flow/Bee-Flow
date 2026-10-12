/**
 * The dependency graph of a Solution.
 *
 * This module is the spine of packaging, not a UI nicety: an edge pointing
 * INSIDE the project is a reference a Blueprint rewrites on install, and an
 * edge pointing OUTSIDE it is something the installer must supply by hand. Get
 * that classification wrong and you ship a Blueprint that installs cleanly and
 * does nothing.
 *
 * Every broken-edge class gets a named case below, because broken edges are the
 * whole point. The sharpest is CROSS-OWNER: actionExecutor refuses to run an
 * automation whose owner is not the app's owner, and a webpage bridge runs
 * acts-as-author — so a project two people built together can be wired
 * perfectly and still fail for everyone, with nothing saying so until a user
 * presses the button.
 *
 * Pure — plain objects, no database.
 *
 * Run: cd server && node --test projects/graph.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildProjectGraph, PROBLEM } = require('./graph');

const ALICE = 'alice';
const BOB = 'bob';

const automation = (id, over = {}) => ({
    id, title: `Automation ${id}`, userId: ALICE, kind: 'automation',
    definition: { steps: [] }, ...over,
});
const app = (id, definition, over = {}) => ({ id, name: `App ${id}`, userId: ALICE, definition, ...over });
const webpage = (id, automationIds, over = {}) => ({
    id, name: `Page ${id}`, userId: ALICE,
    bridgeGrants: { automations: automationIds.map(a => ({ automationId: a })) }, ...over,
});

const problemCodes = (g) => g.problems.map(p => p.code);

// ═══ The happy shape ═════════════════════════════════════════════════

test('a wired solution has edges and no problems', () => {
    const g = buildProjectGraph({
        project: { id: 'p1' },
        automations: [automation('a1')],
        apps: [app('app1', { screens: [{ sections: [{ children: [{ onClick: { kind: 'run_automation', automationId: 'a1' } }] }] }] })],
        webpages: [webpage('w1', ['a1'])],
    });

    assert.strictEqual(g.problems.length, 0);
    assert.strictEqual(g.externals.length, 0);
    assert.strictEqual(g.nodes.length, 3);
    assert.strictEqual(g.edges.length, 2, 'the app runs it, and the page is allowed to');
    assert.ok(g.edges.every(e => e.to === 'automation:a1' && e.problem === null));
});

test('references are found however deep they are nested', () => {
    // The same id can sit on an action, a sequence step or a component prop —
    // which is why this walks objects rather than a known list of places.
    const g = buildProjectGraph({
        automations: [automation('a1')],
        apps: [app('app1', {
            screens: [{ sections: [{ children: [
                { props: { deeply: { nested: { onClick: { kind: 'run_automation', automationId: 'a1' } } } } },
            ] }] }],
            actions: { doIt: { kind: 'sequence', steps: [{ kind: 'run_automation', automationId: 'a1' }] } },
        })],
    });
    assert.strictEqual(g.edges.filter(e => e.kind === 'runs').length, 2);
});

// ═══ Broken edge classes ═════════════════════════════════════════════

test('UNWIRED — the "connect an automation" state every template ships in', () => {
    const g = buildProjectGraph({
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: null } } })],
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.UNWIRED]);
    assert.match(g.problems[0].message, /never got an automation picked/);
    assert.strictEqual(g.edges[0].to, null);
});

test('MISSING — the target does not exist anywhere', () => {
    const g = buildProjectGraph({
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: 'ghost' } } })],
        knownAutomationIds: new Set(['a1']),
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.MISSING]);
    assert.strictEqual(g.externals.length, 0, 'something gone is not a dependency to satisfy');
});

test('EXTERNAL — it exists, but outside this Solution, so packaging cannot carry it', () => {
    const g = buildProjectGraph({
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: 'elsewhere' } } })],
        knownAutomationIds: new Set(['elsewhere']),
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.EXTERNAL]);
    assert.match(g.problems[0].message, /packaging cannot carry it/);
    assert.deepStrictEqual(g.externals, [{ kind: 'automation', id: 'elsewhere', referencedBy: ['app:app1'] }]);
});

test('UNRESOLVED — "I could not check" is never reported as "it is gone"', () => {
    // No knownAutomationIds supplied: the module can tell the target is not
    // HERE, and must not claim to know whether it exists at all.
    const g = buildProjectGraph({
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: 'elsewhere' } } })],
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.UNRESOLVED]);
    assert.strictEqual(g.externals.length, 1, 'still a dependency, whatever its fate');
});

test('CROSS_OWNER — wired correctly, and broken for everyone', () => {
    const g = buildProjectGraph({
        automations: [automation('a1', { userId: BOB })],
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: 'a1' } } }, { userId: ALICE })],
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.CROSS_OWNER]);
    assert.match(g.problems[0].message, /refuse at the moment someone presses the button/);
    assert.strictEqual(g.edges[0].problem, PROBLEM.CROSS_OWNER);
});

test('CROSS_OWNER applies to the webpage bridge too — it runs acts-as-author', () => {
    const g = buildProjectGraph({
        automations: [automation('a1', { userId: BOB })],
        webpages: [webpage('w1', ['a1'], { userId: ALICE })],
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.CROSS_OWNER]);
});

test('a same-owner edge is not flagged', () => {
    const g = buildProjectGraph({
        automations: [automation('a1', { userId: ALICE })],
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: 'a1' } } }, { userId: ALICE })],
    });
    assert.strictEqual(g.problems.length, 0);
});

// ═══ call_block, and the query that used to hide blocks ══════════════

test('a call_block to a block IN this project is a clean edge', () => {
    // Only true because the caller asked for every kind. The project listing
    // filters to kind='automation', and a graph built from THAT would call this
    // an external dependency purely because the query could not see the block.
    const g = buildProjectGraph({
        automations: [
            automation('a1', { definition: { steps: [{ id: 's1', type: 'call_block', blockId: 'blk1' }] } }),
            automation('blk1', { kind: 'block' }),
        ],
    });
    assert.strictEqual(g.problems.length, 0);
    assert.strictEqual(g.edges[0].kind, 'calls');
    assert.strictEqual(g.edges[0].to, 'automation:blk1');
});

test('a block owned by someone else is fine — it runs inside the caller', () => {
    const g = buildProjectGraph({
        automations: [
            automation('a1', { userId: ALICE, definition: { steps: [{ id: 's1', type: 'call_block', blockId: 'blk1' }] } }),
            automation('blk1', { kind: 'block', userId: BOB }),
        ],
    });
    assert.strictEqual(g.problems.length, 0, 'ownership gates the acts-as-owner paths, not this one');
});

// ═══ Approvals as policy, never as decision ══════════════════════════

test('an approval step becomes a node hanging off its automation', () => {
    const g = buildProjectGraph({
        automations: [automation('a1', {
            definition: { steps: [{ id: 's1', type: 'approval', prompt: 'Ship it?' }] },
        })],
    });
    const approval = g.nodes.find(n => n.type === 'approval');
    assert.ok(approval);
    assert.strictEqual(approval.name, 'Ship it?');
    assert.strictEqual(approval.entityId, null, 'a policy, not a row — no decision is being drawn');
    assert.ok(g.edges.some(e => e.kind === 'asks' && e.to === approval.id));
});

test('approvals inside loops, branches and layers are all found', () => {
    const g = buildProjectGraph({
        automations: [automation('a1', {
            definition: {
                steps: [
                    { id: 'l1', type: 'loop', body: [{ id: 'inLoop', type: 'approval', prompt: 'In a loop' }] },
                    { id: 'p1', type: 'parallel', branches: [[{ id: 'inBranch', type: 'approval', prompt: 'In a branch' }]] },
                ],
                layers: { enrich: { steps: [{ id: 'inLayer', type: 'approval', prompt: 'In a layer' }] } },
            },
        })],
    });
    const names = g.nodes.filter(n => n.type === 'approval').map(n => n.name).sort();
    assert.deepStrictEqual(names, ['In a branch', 'In a layer', 'In a loop']);
    assert.strictEqual(g.nodes.find(n => n.name === 'In a layer').layerKey, 'enrich');
});

test('an app that asks for approval directly gets a node too', () => {
    const g = buildProjectGraph({
        apps: [app('app1', { actions: { ask: { id: 'ask', kind: 'request_approval' } } })],
    });
    const approval = g.nodes.find(n => n.type === 'approval');
    assert.ok(approval, 'an app can raise one with no automation involved at all');
    assert.ok(g.edges.some(e => e.from === 'app:app1' && e.kind === 'asks'));
});

// ═══ Shape and robustness ════════════════════════════════════════════

test('two references to the same external target are one dependency', () => {
    const g = buildProjectGraph({
        apps: [
            app('app1', { actions: { go: { kind: 'run_automation', automationId: 'x' } } }),
            app('app2', { actions: { go: { kind: 'run_automation', automationId: 'x' } } }),
        ],
    });
    assert.strictEqual(g.externals.length, 1);
    assert.deepStrictEqual(g.externals[0].referencedBy, ['app:app1', 'app:app2']);
});

test('an empty project is an empty graph, not a crash', () => {
    const g = buildProjectGraph({ project: { id: 'p1' } });
    assert.deepStrictEqual(g, { projectId: 'p1', nodes: [], edges: [], externals: [], problems: [] });
});

test('malformed members are skipped rather than thrown over', () => {
    const g = buildProjectGraph({
        automations: [null, automation('a1', { definition: null })],
        apps: [null, app('app1', undefined)],
        webpages: [null, webpage('w1', []), { id: 'w2', name: 'No grants' }],
    });
    assert.strictEqual(g.problems.length, 0);
    // The nulls are dropped; the four real entities still get their nodes.
    assert.strictEqual(g.nodes.length, 4);
});

test('a non-string reference is treated as unwired, not as an id', () => {
    const g = buildProjectGraph({
        apps: [app('app1', { actions: { go: { kind: 'run_automation', automationId: { $ref: 'nope' } } } })],
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.UNWIRED]);
});

// ═══ The rest of the Solution: tables, agents, meetings, forms ════════
//
// Every edge below comes from something already on disk, and every one of them
// is a reference a Blueprint has to either rewrite or report. The classes are
// the same five as above — what changes is only the NOUN in the sentence, so a
// missing table does not read as a missing automation.

const datatable = (id, over = {}) => ({ id, name: `Table ${id}`, ownerUserId: ALICE, ...over });
const agent = (id, config, over = {}) => ({ id, name: `Agent ${id}`, ownerId: ALICE, config, ...over });
const kb = (id, over = {}) => ({ id, name: `Base ${id}`, ...over });
const withStep = (id, step, over = {}) => automation(id, {
    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [step] },
    ...over,
});

test('an automation that reads a table in this project draws one clean edge', () => {
    const g = buildProjectGraph({
        automations: [withStep('a1', { id: 's1', type: 'datatable', op: 'list', datatableId: 'tbl1' })],
        datatables: [datatable('tbl1')],
    });
    const edge = g.edges.find(e => e.kind === 'reads');
    assert.ok(edge, 'the edge exists');
    assert.strictEqual(edge.to, 'datatable:tbl1');
    assert.strictEqual(edge.problem, null);
    assert.strictEqual(g.problems.length, 0);
});

test('writing to a table is a different verb from reading it', () => {
    const g = buildProjectGraph({
        automations: [withStep('a1', { id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl1', values: { x: 1 } })],
        datatables: [datatable('tbl1')],
    });
    assert.deepStrictEqual(g.edges.map(e => e.kind), ['writes']);
});

test('a table step buried in a loop still counts', () => {
    const g = buildProjectGraph({
        automations: [withStep('a1', {
            id: 'loop', type: 'loop',
            body: [{ id: 's1', type: 'datatable', op: 'list', datatableId: 'tbl1' }],
        })],
        datatables: [datatable('tbl1')],
    });
    assert.strictEqual(g.edges.filter(e => e.kind === 'reads').length, 1);
});

test('a table outside this project is named as a TABLE, not as an automation', () => {
    // The prose bug this pins: before the noun was a parameter, every broken
    // edge said "an automation", so a missing table read as a missing automation and
    // sent whoever fixed it to the wrong screen.
    const g = buildProjectGraph({
        automations: [withStep('a1', { id: 's1', type: 'datatable', op: 'list', datatableId: 'tbl_elsewhere' })],
        knownDatatableIds: new Set(['tbl_elsewhere']),
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.EXTERNAL]);
    assert.match(g.problems[0].message, /depends on a table outside this project/);
    assert.deepStrictEqual(g.externals, [{ kind: 'datatable', id: 'tbl_elsewhere', referencedBy: ['automation:a1'] }]);
});

test('a table that is gone is MISSING, and "I could not check" is UNRESOLVED', () => {
    const gone = buildProjectGraph({
        automations: [withStep('a1', { id: 's1', type: 'datatable', op: 'list', datatableId: 'ghost' })],
        knownDatatableIds: new Set(['tbl1']),
    });
    assert.deepStrictEqual(problemCodes(gone), [PROBLEM.MISSING]);
    assert.match(gone.problems[0].message, /points at a table that no longer exists/);

    const unchecked = buildProjectGraph({
        automations: [withStep('a1', { id: 's1', type: 'datatable', op: 'list', datatableId: 'ghost' })],
    });
    assert.deepStrictEqual(problemCodes(unchecked), [PROBLEM.UNRESOLVED]);
    assert.strictEqual(unchecked.externals.length, 1, 'still a dependency, whatever its fate');
});

test('a table id an export already cleared raises nothing at all', () => {
    // portability empties `datatableId` to '' on export. That is a step waiting
    // to be re-pointed, not a broken reference, and it must not fill the Flow
    // tab with problems on every imported automation.
    const g = buildProjectGraph({
        automations: [withStep('a1', { id: 's1', type: 'datatable', op: 'list', datatableId: '', datatableKey: 'invoices' })],
    });
    assert.deepStrictEqual(g.problems, []);
    assert.deepStrictEqual(g.edges, []);
});

test('an app draws NO table edge yet, and that is the honest answer', () => {
    // The binding does not exist in a readable form and the usage index has no
    // app rows. Zero is a fact; a guessed line would not be. This test is the
    // marker for whoever lands the reconciler.
    const g = buildProjectGraph({
        apps: [app('app1', { screens: [{ datatableId: 'tbl1' }] })],
        datatables: [datatable('tbl1')],
    });
    assert.strictEqual(g.edges.length, 0);
    assert.strictEqual(g.problems.length, 0);
});

test('an agent is grounded on the knowledge bases in this project', () => {
    const g = buildProjectGraph({
        agents: [agent('ag1', { knowledge_base_ids: ['kb1'] })],
        knowledgeBases: [kb('kb1')],
    });
    assert.deepStrictEqual(g.edges.map(e => [e.kind, e.to]), [['grounds', 'knowledge_base:kb1']]);
    assert.strictEqual(g.problems.length, 0);
});

test('a base the agent uses but the project does not hold is a dependency', () => {
    const g = buildProjectGraph({
        agents: [agent('ag1', { knowledge_base_ids: ['kb_elsewhere'] })],
        knownKnowledgeBaseIds: new Set(['kb_elsewhere']),
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.EXTERNAL]);
    assert.match(g.problems[0].message, /depends on a knowledge base outside this project/);
    assert.strictEqual(g.externals[0].kind, 'knowledge_base');
});

test('a skill is ALWAYS outside the Solution, and says so as a skill', () => {
    // Skills are not project members and never will be one, so this edge can
    // only ever leave. Reporting it is what puts it in `requires`.
    const g = buildProjectGraph({
        agents: [agent('ag1', { attachedSkillIds: ['skl_1'] })],
    });
    assert.deepStrictEqual(problemCodes(g), [PROBLEM.UNRESOLVED]);
    assert.match(g.problems[0].message, /points at a skill that is not in this project/);
    assert.deepStrictEqual(g.externals, [{ kind: 'skill', id: 'skl_1', referencedBy: ['agent:ag1'] }]);
});

test('an agent with neither bases nor skills draws nothing', () => {
    const g = buildProjectGraph({ agents: [agent('ag1', {})] });
    assert.deepStrictEqual(g.edges, []);
    assert.strictEqual(g.nodes.length, 1, 'the agent itself is still on the canvas');
});

test('junk in the two config lists is skipped, never turned into an edge', () => {
    const g = buildProjectGraph({
        agents: [agent('ag1', { knowledge_base_ids: [null, '', 42, { id: 'kb1' }], attachedSkillIds: 'not-a-list' })],
    });
    assert.deepStrictEqual(g.edges, []);
    assert.deepStrictEqual(g.problems, []);
});

test('a meeting tag feeding a base is one node however many sources share it', () => {
    const g = buildProjectGraph({
        knowledgeBases: [kb('kb1'), kb('kb2')],
        meetingSources: [
            { knowledgeBaseId: 'kb1', tag: 'sales' },
            { knowledgeBaseId: 'kb2', tag: 'sales' },
        ],
    });
    assert.strictEqual(g.nodes.filter(n => n.type === 'meeting').length, 1);
    assert.deepStrictEqual(g.edges.map(e => [e.from, e.kind, e.to]), [
        ['meeting:sales', 'feeds', 'knowledge_base:kb1'],
        ['meeting:sales', 'feeds', 'knowledge_base:kb2'],
    ]);
});

test('a meeting source with no tag or no base is not half-drawn', () => {
    const g = buildProjectGraph({
        knowledgeBases: [kb('kb1')],
        meetingSources: [{ knowledgeBaseId: 'kb1' }, { tag: 'sales' }, { knowledgeBaseId: 'kb1', tag: '  ' }, null],
    });
    assert.deepStrictEqual(g.edges, []);
    assert.strictEqual(g.nodes.filter(n => n.type === 'meeting').length, 0);
});

test('an automation triggered by a form gets a form node, and never its token', () => {
    const g = buildProjectGraph({
        automations: [automation('a1', {
            definition: {
                schemaVersion: 2,
                trigger: { id: 't', type: 'trigger', kind: 'form', form: { title: 'Leave request' } },
                steps: [],
            },
        })],
    });
    const form = g.nodes.find(n => n.type === 'form');
    assert.ok(form, 'the form is on the canvas');
    assert.strictEqual(form.name, 'Leave request');
    assert.strictEqual(form.entityId, null, 'a form page is not an entity here');
    assert.deepStrictEqual(g.edges.map(e => [e.from, e.kind, e.to]), [['form:a1', 'triggers', 'automation:a1']]);
});

test('the form node is keyed on the AUTOMATION — a page id is a credential', () => {
    // automation_form_pages.id IS the public URL and the only thing guarding
    // it. It is never read to build this graph, so it cannot leak through one.
    const g = buildProjectGraph({
        automations: [automation('a1', {
            definition: { trigger: { kind: 'form', pageId: 'SECRET-TOKEN', form: {} }, steps: [] },
        })],
    });
    assert.ok(!JSON.stringify(g).includes('SECRET-TOKEN'));
    assert.strictEqual(g.nodes.find(n => n.type === 'form').name, 'Form', 'an unnamed form still reads as one');
});

test('a manual automation gets no form node', () => {
    const g = buildProjectGraph({ automations: [automation('a1')] });
    assert.strictEqual(g.nodes.filter(n => n.type === 'form').length, 0);
});

/**
 * The "Te controleren" aggregator.
 *
 * Every rule here decides whether a person is told about something broken, and
 * one of them decides whether a broken Solution can be published. So each rule
 * gets a bite test (it fires when it should) and the verdict gets a refusal
 * test (it blocks when the truth is unknown).
 *
 * `buildCompleteness` is pure, so nothing below touches a store — the one
 * store read the feature needs (a knowledge base's document count) is a
 * parameter, which is exactly why it was made one.
 *
 * Run: cd server && node --test --test-force-exit projects/completeness.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildCompleteness, collectRequires, deepLinkFor, stageFor, toFindingKind } = require('./completeness');
const { buildProjectGraph } = require('./graph');

/** A definition that validates clean, so a fixture's noise is deliberate. */
function cleanApp(id = 'app1', name = 'Desk') {
    return {
        id, name, userId: 'alice',
        definition: {
            schemaVersion: 2, meta: { name },
            screens: [{ id: 'scr_home', name: 'Home', sections: [{ id: 'sec_1', children: [{ id: 'cmp_t1', type: 'text', props: { text: 'hi' } }] }] }],
            actions: {},
        },
    };
}

function cleanRoutine(id = 'a1', title = 'Nightly', extra = {}) {
    return {
        id, title, userId: 'alice', isActive: false, isDraft: true,
        definition: { trigger: { id: 'trg1', kind: 'manual' }, steps: [], edges: [] },
        ...extra,
    };
}

// ═══ The baseline ════════════════════════════════════════════════════

test('a clean Solution has nothing to report and may publish', () => {
    const out = buildCompleteness({
        graph: buildProjectGraph({ project: { id: 'p1' }, apps: [cleanApp()], automations: [cleanRoutine()] }),
        apps: [cleanApp()], automations: [cleanRoutine()],
    });
    assert.deepStrictEqual(out.findings, []);
    assert.strictEqual(out.complete, true);
    assert.strictEqual(out.blocked, false);
});

// ═══ 1. The app validator ════════════════════════════════════════════

test('a button wired to nothing reaches the list, with the app id the validator never saw', () => {
    const app = cleanApp();
    app.definition.screens[0].sections[0].children = [{ id: 'b1', type: 'button', props: { label: 'Go' } }];

    const out = buildCompleteness({ apps: [app] });
    const inert = out.findings.find(f => f.code === 'component.control_inert');
    assert.ok(inert, 'the rule fires');
    assert.strictEqual(inert.severity, 'warning');
    assert.strictEqual(inert.targetRef.id, 'app1');
    assert.strictEqual(inert.targetRef.title, 'Desk');
    assert.strictEqual(inert.deepLink, '/app/studio/apps/app1');
    assert.strictEqual(out.blocked, false, 'advice does not block a release');
});

test('the index-based path is translated back into a screen id', () => {
    const app = cleanApp();
    app.definition.screens[0].sections[0].children = [{ id: 'b1', type: 'button', props: { label: 'Go' } }];

    const out = buildCompleteness({ apps: [app] });
    const inert = out.findings.find(f => f.code === 'component.control_inert');
    assert.strictEqual(inert.targetRef.path, 'screens[0].sections[0].children[0]');
    assert.strictEqual(inert.targetRef.screenId, 'scr_home', 'the id is what a link would need; the index is not');
});

test('an app stored before the v2 migration is not accused of a bad schemaVersion', () => {
    // The validator assumes canonical input. Handing it the raw row would
    // produce shape.schema_version — an ERROR, and therefore a publish block
    // this module invented rather than found.
    const app = {
        id: 'old1', name: 'Legacy', userId: 'alice',
        definition: { schemaVersion: 1, meta: { name: 'Legacy' }, screens: [{ id: 's1', name: 'Home', sections: [] }], actions: {} },
    };
    const out = buildCompleteness({ apps: [app] });
    assert.ok(!out.findings.some(f => f.code === 'shape.schema_version'), JSON.stringify(out.findings));
    assert.strictEqual(out.blocked, false);
});

test('an app whose definition cannot be validated blocks instead of reading as clean', () => {
    // A value structuredClone refuses: the validator never runs, and "no
    // findings" would be a lie about the app rather than a fact.
    const app = cleanApp();
    app.definition.screens[0].onEnter = () => {};

    const out = buildCompleteness({ apps: [app] });
    assert.deepStrictEqual(out.findings, []);
    assert.ok(out.unavailable.includes('apps'));
    assert.strictEqual(out.blocked, true, 'an unvalidatable app is not a clean app');
});

// ═══ 2. The routine ladder ═══════════════════════════════════════════

test('a DRAFT routine\'s missing field is advice tagged blockedAt: activate', () => {
    const draft = cleanRoutine();
    draft.definition.steps = [{ id: 's1', type: 'ai_step' }];        // prompt missing
    draft.definition.edges = [{ from: 'trg1', to: 's1' }];

    const out = buildCompleteness({ automations: [draft] });
    const f = out.findings.find(x => x.code === 'ai_step.prompt_missing');
    assert.ok(f, JSON.stringify(out.findings.map(x => x.code)));
    assert.strictEqual(f.severity, 'warning');
    assert.strictEqual(f.blockedAt, 'activate');
    assert.strictEqual(out.blocked, false, 'a half-built draft must not lock the release button');
});

test('the SAME routine, live, blocks — the completeness code is an error at activate', () => {
    const live = cleanRoutine('a1', 'Nightly', { isActive: true, isDraft: false });
    live.definition.steps = [{ id: 's1', type: 'ai_step' }];
    live.definition.edges = [{ from: 'trg1', to: 's1' }];

    const out = buildCompleteness({ automations: [live] });
    const f = out.findings.find(x => x.code === 'ai_step.prompt_missing');
    assert.ok(f);
    assert.strictEqual(f.severity, 'error');
    assert.strictEqual(f.targetRef.id, 'a1');
    assert.strictEqual(f.deepLink, '/app/studio/automations/a1');
    assert.strictEqual(out.blocked, true);
});

test('stageFor: only a live, non-draft routine is held to the activate bar', () => {
    assert.strictEqual(stageFor({ isActive: true, isDraft: false }), 'activate');
    assert.strictEqual(stageFor({ isActive: true, isDraft: true }), 'draft');
    assert.strictEqual(stageFor({ isActive: false, isDraft: false }), 'draft');
    assert.strictEqual(stageFor(null), 'draft');
});

// ═══ 3. A knowledge base something reads, holding nothing ════════════

const AGENT_ON_KB = {
    agents: [{ id: 'ag1', name: 'Helper', ownerId: 'alice', config: { knowledge_base_ids: ['kb1'] } }],
    knowledgeBases: [{ id: 'kb1', name: 'Handbook' }],
};

test('an empty knowledge base an agent is grounded on is reported', () => {
    const graph = buildProjectGraph({ project: { id: 'p1' }, ...AGENT_ON_KB });
    const out = buildCompleteness({
        graph, knowledgeBases: AGENT_ON_KB.knowledgeBases, kbDocumentCounts: { kb1: 0 },
    });
    const f = out.findings.find(x => x.code === 'knowledge_base.empty_in_use');
    assert.ok(f, JSON.stringify(out.findings.map(x => x.code)));
    assert.strictEqual(f.kind, 'kb', 'the graph says knowledge_base; the palette says kb');
    assert.strictEqual(f.deepLink, '/app/studio/knowledge/kb1');
    assert.strictEqual(out.blocked, false, 'a Blueprint carries the shell, so an empty base is not a gate');
});

test('a base with documents is not reported', () => {
    const graph = buildProjectGraph({ project: { id: 'p1' }, ...AGENT_ON_KB });
    const out = buildCompleteness({ graph, knowledgeBases: AGENT_ON_KB.knowledgeBases, kbDocumentCounts: { kb1: 3 } });
    assert.ok(!out.findings.some(x => x.code === 'knowledge_base.empty_in_use'));
});

test('an empty base NOTHING reads is not reported — unused is not broken', () => {
    const graph = buildProjectGraph({ project: { id: 'p1' }, knowledgeBases: AGENT_ON_KB.knowledgeBases });
    const out = buildCompleteness({ graph, knowledgeBases: AGENT_ON_KB.knowledgeBases, kbDocumentCounts: { kb1: 0 } });
    assert.ok(!out.findings.some(x => x.code === 'knowledge_base.empty_in_use'));
});

test('a base only FED by meetings is not called empty — it is waiting', () => {
    const graph = buildProjectGraph({
        project: { id: 'p1' },
        knowledgeBases: AGENT_ON_KB.knowledgeBases,
        meetingSources: [{ knowledgeBaseId: 'kb1', tag: 'sales' }],
    });
    const out = buildCompleteness({ graph, knowledgeBases: AGENT_ON_KB.knowledgeBases, kbDocumentCounts: { kb1: 0 } });
    assert.ok(!out.findings.some(x => x.code === 'knowledge_base.empty_in_use'));
});

test('an UNREADABLE document count is a named gap, never "it is empty"', () => {
    const graph = buildProjectGraph({ project: { id: 'p1' }, ...AGENT_ON_KB });
    const out = buildCompleteness({ graph, knowledgeBases: AGENT_ON_KB.knowledgeBases, kbDocumentCounts: { kb1: null } });
    assert.ok(!out.findings.some(x => x.code === 'knowledge_base.empty_in_use'),
        'accusing a base of being empty on an unanswered count is the fail-open');
    assert.ok(out.unavailable.includes('knowledgeBaseDocuments'));
    assert.strictEqual(out.blocked, true);
});

// ═══ 4. The dependency graph's problems ══════════════════════════════

test('a cross-owner run edge arrives as a blocking finding', () => {
    const app = cleanApp();
    app.definition.actions = { act1: { kind: 'run_automation', automationId: 'a1' } };
    const routine = cleanRoutine();
    routine.userId = 'bob';                       // …owned by somebody else

    const graph = buildProjectGraph({ project: { id: 'p1' }, apps: [app], automations: [routine] });
    const out = buildCompleteness({ graph, apps: [app], automations: [routine] });

    const f = out.findings.find(x => x.code === 'cross_owner');
    assert.ok(f, JSON.stringify(out.findings.map(x => x.code)));
    assert.strictEqual(f.severity, 'error');
    assert.strictEqual(f.targetRef.id, 'app1', 'the app HOLDS the broken reference, so that is where Show me goes');
    assert.strictEqual(out.blocked, true);
});

test('a graph problem about a knowledge base does not take the whole list down', () => {
    // graph.js spells it `knowledge_base`; makeFinding only knows `kb` and
    // THROWS on anything else. Without the mapping this one record would empty
    // the list — and an empty list is what "nothing to fix" looks like.
    const graph = buildProjectGraph({
        project: { id: 'p1' },
        knowledgeBases: [],
        meetingSources: [{ knowledgeBaseId: 'kb_gone', tag: 'sales' }],
    });
    assert.ok(graph.problems.length > 0, 'the fixture really does produce a problem');

    const out = buildCompleteness({ graph });
    assert.strictEqual(out.findings.length, graph.problems.length);
    assert.strictEqual(out.findings[0].kind, 'kb');
    assert.ok(!out.unavailable.includes('graphProblems'));
});

test('a record the Finding shape REFUSES becomes a named gap, never a silent drop', () => {
    // The catch inside convert() is the module's own safety net: a validator
    // record that cannot be turned into a Finding must not disappear, because a
    // finding that never reaches the screen is exactly the silence this module
    // exists to remove. `severity: 'blocker'` is not in SEVERITIES, so
    // makeFinding throws on it.
    const out = buildCompleteness({
        graph: { problems: [{ code: 'cross_owner', severity: 'blocker', kind: 'app', message: 'Desk runs someone else\'s routine.' }] },
    });
    assert.deepStrictEqual(out.findings, [], 'the record genuinely could not be converted');
    assert.ok(out.unavailable.includes('graphProblems'),
        'a dropped finding is a gap in the picture, not an absence of problems');
    assert.strictEqual(out.blocked, true, 'and the gap blocks, like every other gap');
});

test('errors sort above warnings, so what blocks is read first', () => {
    const app = cleanApp();
    app.definition.screens[0].sections[0].children = [{ id: 'b1', type: 'button', props: { label: 'Go' } }];
    const live = cleanRoutine('a1', 'Nightly', { isActive: true, isDraft: false });
    live.definition.steps = [{ id: 's1', type: 'ai_step' }];
    live.definition.edges = [{ from: 'trg1', to: 's1' }];

    const out = buildCompleteness({ apps: [app], automations: [live] });
    assert.strictEqual(out.findings[0].severity, 'error');
    assert.strictEqual(out.findings[out.findings.length - 1].severity, 'warning');
});

// ═══ The verdict: unknown blocks ═════════════════════════════════════

test('a store the loader could not read blocks publishing even with an empty list', () => {
    const out = buildCompleteness({ unavailable: ['automations'] });
    assert.deepStrictEqual(out.findings, []);
    assert.strictEqual(out.complete, false);
    assert.strictEqual(out.blocked, true,
        'THE bug this module exists to prevent: no findings because nothing was read');
});

test('a clean Solution with no gaps is the ONLY way to reach blocked: false', () => {
    const out = buildCompleteness({});
    assert.strictEqual(out.blocked, false);
    assert.strictEqual(out.complete, true);
});

// ═══ Deep links ══════════════════════════════════════════════════════

test('a finding with no id gets no link rather than a link to nowhere', () => {
    assert.strictEqual(deepLinkFor({ targetRef: { kind: 'app', id: null } }), null);
    assert.strictEqual(deepLinkFor({ targetRef: { kind: 'solution', id: 'p1' } }), null);
    assert.strictEqual(deepLinkFor(null), null);
});

test('kind vocabulary: the graph\'s knowledge_base is the palette\'s kb', () => {
    assert.strictEqual(toFindingKind('knowledge_base'), 'kb');
    assert.strictEqual(toFindingKind('app'), 'app');
});

// ═══ Typed requires ══════════════════════════════════════════════════

test('a datatable step names the AUTHOR\'S key, the step and the layer', () => {
    const routine = cleanRoutine();
    routine.definition.steps = [{ id: 'st1', type: 'datatable', datatableId: 'dt_live', datatableKey: 'invoices', op: 'insert' }];

    const { items, counts } = collectRequires({ automations: [routine] });
    const dt = items.find(i => i.kind === 'datatable');
    assert.ok(dt, JSON.stringify(items));
    assert.strictEqual(dt.datatableKey, 'invoices');
    assert.strictEqual(dt.stepId, 'st1');
    assert.strictEqual(dt.automationId, 'a1');
    assert.strictEqual(counts.datatable, 1);
});

test('a saved connection and an approver seat travel as requirements, never as people', () => {
    const routine = cleanRoutine();
    routine.definition.steps = [
        { id: 'h1', type: 'http_request', auth: { connectionId: 'conn_1' } },
        { id: 'ap1', type: 'approval', prompt: 'Ship it?', approval: { approvers: ['u_alice'] } },
    ];

    const { items } = collectRequires({ automations: [routine] });
    const conn = items.find(i => i.kind === 'connection');
    const appr = items.find(i => i.kind === 'approver');
    assert.ok(conn && conn.stepId === 'h1');
    assert.ok(appr && appr.stepId === 'ap1');
    // The seat FIELD says what has to be re-picked; the person never travels.
    assert.ok(!JSON.stringify(items).includes('u_alice'), 'an approver id is a person');
});

test('collecting requirements never mutates the routine it reads', () => {
    const routine = cleanRoutine();
    routine.definition.steps = [{ id: 'st1', type: 'datatable', datatableId: 'dt_live', datatableKey: 'invoices', op: 'insert' }];
    const before = JSON.stringify(routine.definition);

    collectRequires({ automations: [routine] });
    assert.strictEqual(JSON.stringify(routine.definition), before,
        'the scrub is run on a CLONE — packaging is frozen and this only reads it');
});

test('what leaves the bundle by reference is listed with how many things point at it', () => {
    const routine = cleanRoutine();
    routine.definition.steps = [{ id: 'st1', type: 'call_block', blockId: 'blk_elsewhere' }];
    routine.definition.edges = [{ from: 'trg1', to: 'st1' }];
    const graph = buildProjectGraph({ project: { id: 'p1' }, automations: [routine] });

    const { items } = collectRequires({ automations: [routine], graph });
    const ext = items.find(i => i.externalId === 'blk_elsewhere');
    assert.ok(ext, JSON.stringify(items));
    assert.strictEqual(ext.kind, 'automation');
    assert.strictEqual(ext.referencedBy, 1);
});


// ═══ What the requirements walk could not read ═══════════════════════
//
// The export dialog draws "whoever installs this has to supply …" entirely
// from `requires.items`, and an EMPTY list is what a self-contained Solution
// looks like. So a routine this walk skipped must not print the same screen as
// a routine it read and found nothing in.

// Two paths name this same gap — the findings walk (section 2) and the
// requirements walk — so either one alone holds the verdict. That is on
// purpose: the label is the fact, not which loop noticed it.
test('a routine handed over without its definition is a named gap, not a clean bill', () => {
    const out = buildCompleteness({ automations: [{ id: 'a1', title: 'Nightly' }] });
    assert.deepStrictEqual(out.requires.items, []);
    assert.ok(out.unavailable.includes('automations'), 'the gap is named');
    assert.strictEqual(out.complete, false);
    assert.strictEqual(out.blocked, true, 'an empty requirements list nobody produced must not release a publish');
});

test('collectRequires says so itself, so any caller can fold it in', () => {
    const { items, unreadable } = collectRequires({ automations: [{ id: 'a1' }, cleanRoutine('a2')] });
    assert.deepStrictEqual(items, []);
    assert.deepStrictEqual(unreadable, ['automations']);
});

test('a routine that WAS read contributes no gap', () => {
    const out = buildCompleteness({ automations: [cleanRoutine()] });
    assert.deepStrictEqual(out.requires.unreadable, []);
    assert.ok(!out.unavailable.includes('automations'));
});

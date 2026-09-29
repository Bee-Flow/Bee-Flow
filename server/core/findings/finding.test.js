/**
 * The one Finding shape, and the proof that every producer already fits it.
 *
 * Three surfaces draw the "needs attention" list, and four validators feed
 * it. The shape only earns its name if (a) a malformed Finding is refused
 * loudly rather than rendered grey, and (b) each producer's records convert
 * without a per-producer adapter. Half of this file is the shape; the other
 * half runs the real validators — App Studio's control_inert, the routine
 * validator's draft/activate ladder, the Solution dependency graph — and
 * converts what they emit.
 *
 * Run: node --test --test-force-exit core/findings/finding.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    makeFinding, fromLegacy, isFinding, bySeverity, FindingShapeError,
    SEVERITIES, BLOCKED_AT, FINDING_KINDS,
} = require('./finding');

const good = () => ({
    code: 'component.control_inert',
    severity: 'warning',
    kind: 'app',
    targetRef: { kind: 'app', id: 'app_1', title: 'Offerteportaal', path: 'screens[0].sections[0].children[2]', nodeId: 'cmp_btn' },
    message: 'This button is wired to nothing — clicking it does nothing at all.',
    remediation: 'Set onClick to an action, or give it role "submit" inside a form.',
});

// ═══ makeFinding ═════════════════════════════════════════════════════════

test('a well-formed finding comes back with exactly the contract fields', () => {
    const f = makeFinding({ ...good(), somethingElse: 1 });
    assert.deepEqual(Object.keys(f).sort(), ['code', 'kind', 'message', 'remediation', 'severity', 'targetRef']);
    assert.deepEqual(f.targetRef, good().targetRef);
    assert.equal('somethingElse' in f, false, 'unknown keys are dropped — consumers rely on exactly this set');
});

test('optional fields are absent, not undefined, when not given', () => {
    const f = makeFinding({ code: 'x', severity: 'info', kind: 'kb', targetRef: { kind: 'kb', id: 'kb1' }, message: 'm' });
    assert.equal('blockedAt' in f, false);
    assert.equal('remediation' in f, false);
    assert.deepEqual(f.targetRef, { kind: 'kb', id: 'kb1' });
});

test('blockedAt is carried when valid and refused otherwise', () => {
    assert.equal(makeFinding({ ...good(), blockedAt: 'activate' }).blockedAt, 'activate');
    assert.equal(makeFinding({ ...good(), blockedAt: 'publish' }).blockedAt, 'publish');
    assert.throws(() => makeFinding({ ...good(), blockedAt: 'never' }), (e) => e instanceof FindingShapeError && e.field === 'blockedAt');
});

test('every wrong field is named in the error', () => {
    const cases = [
        [{ ...good(), code: '' }, 'code'],
        [{ ...good(), severity: 'fatal' }, 'severity'],
        [{ ...good(), kind: 'widget' }, 'kind'],
        [{ ...good(), message: '   ' }, 'message'],
        [{ ...good(), remediation: 42 }, 'remediation'],
        [{ ...good(), targetRef: null }, 'targetRef'],
        [{ ...good(), targetRef: { kind: 'nope', id: 'x' } }, 'targetRef.kind'],
        [{ ...good(), targetRef: { kind: 'app', id: { deep: true } } }, 'targetRef.id'],
        [{ ...good(), targetRef: { kind: 'app', id: 'a', nodeId: ['x'] } }, 'targetRef.nodeId'],
    ];
    for (const [input, field] of cases) {
        assert.throws(() => makeFinding(input), (e) => e instanceof FindingShapeError && e.field === field, `expected ${field} to be refused`);
    }
    assert.throws(() => makeFinding(null), FindingShapeError);
    assert.throws(() => makeFinding('finding'), FindingShapeError);
});

test('targetRef: the kind defaults to the finding kind, ids are strings, null id survives', () => {
    const f = makeFinding({ ...good(), targetRef: { id: 7, nodeId: 3 } });
    assert.deepEqual(f.targetRef, { kind: 'app', id: '7', nodeId: '3' });
    const g = makeFinding({ ...good(), targetRef: { kind: 'app', id: null, title: '', path: undefined } });
    assert.deepEqual(g.targetRef, { kind: 'app', id: null }, 'empty locators are dropped, a null id is kept');
});

test('the vocabularies are the ten Studio kinds and the three severities', () => {
    assert.deepEqual([...SEVERITIES], ['error', 'warning', 'info']);
    assert.deepEqual([...BLOCKED_AT], ['activate', 'publish']);
    assert.deepEqual([...FINDING_KINDS], ['automation', 'datatable', 'app', 'webpage', 'form', 'agent', 'skill', 'kb', 'meeting', 'solution']);
});

test('isFinding is a non-throwing makeFinding; bySeverity puts errors first', () => {
    assert.equal(isFinding(good()), true);
    assert.equal(isFinding({ ...good(), severity: 'loud' }), false);
    assert.equal(isFinding(undefined), false);
    const sorted = [
        { severity: 'info' }, { severity: 'error' }, { severity: 'warning' }, { severity: 'error' }, { severity: 'mystery' },
    ].sort(bySeverity).map((x) => x.severity);
    assert.deepEqual(sorted, ['error', 'error', 'warning', 'info', 'mystery']);
});

// ═══ fromLegacy ══════════════════════════════════════════════════════════

test('fromLegacy: hint → remediation, path/nodeId → targetRef, kind from the caller', () => {
    const f = fromLegacy('app', {
        code: 'binding.table_unset', severity: 'warning', path: 'screens[1].sections[0]', nodeId: 'sec_2',
        message: 'This list has no table.', hint: 'Pick a table.',
    }, { id: 'app_9', title: 'Offerteportaal' });
    assert.deepEqual(f, {
        code: 'binding.table_unset',
        severity: 'warning',
        kind: 'app',
        targetRef: { kind: 'app', id: 'app_9', title: 'Offerteportaal', path: 'screens[1].sections[0]', nodeId: 'sec_2' },
        message: 'This list has no table.',
        remediation: 'Pick a table.',
    });
});

test('fromLegacy: the draft ladder\'s blockedAt rides along, and a record with its own targetRef wins', () => {
    const f = fromLegacy('automation', {
        code: 'trigger.schedule_missing', severity: 'warning', blockedAt: 'activate', path: 'trigger.schedule.cron',
        message: 'Schedule trigger has no schedule — it can never fire.', hint: 'Pick a time.',
        kind: 'automation',
        targetRef: { kind: 'automation', id: 'auto_1', stepId: 'trg' },
    }, { id: 'ignored', title: 'Kredietcheck' });
    assert.equal(f.blockedAt, 'activate');
    assert.deepEqual(f.targetRef, { kind: 'automation', id: 'auto_1', title: 'Kredietcheck', path: 'trigger.schedule.cron', stepId: 'trg' });
});

test('fromLegacy: no hint means no remediation; a record without a message is refused', () => {
    const f = fromLegacy('kb', { code: 'kb.empty', severity: 'info', message: 'Kennisbank test is leeg.' }, { id: 'kb_1' });
    assert.equal('remediation' in f, false);
    assert.deepEqual(f.targetRef, { kind: 'kb', id: 'kb_1' });
    assert.throws(() => fromLegacy('kb', { code: 'kb.empty', severity: 'info' }), (e) => e.field === 'message');
    assert.throws(() => fromLegacy('kb', null), FindingShapeError);
});

// ═══ The producers already fit ═══════════════════════════════════════════

test('App Studio: component.control_inert carries kind + targetRef, and converts', () => {
    const { canonicalizeAppDefinition } = require('../../appStudio/canonicalize');
    const { validateAppDefinition } = require('../../appStudio/validate');
    const def = canonicalizeAppDefinition(structuredClone(require('../../appStudio/fixtures/calculatorApp.json'))).def;

    // Cut the wire of the first button that has one, and remember where it sat.
    let cut = null;
    const walk = (nodes, at) => {
        for (let i = 0; i < (nodes || []).length && !cut; i++) {
            const n = nodes[i];
            if (n?.type === 'button' && n.onClick) { delete n.onClick; cut = { id: n.id, path: `${at}.children[${i}]` }; return; }
            if (Array.isArray(n?.children)) walk(n.children, `${at}.children[${i}]`);
        }
    };
    def.screens.forEach((s, si) => s.sections.forEach((sec, ci) => walk(sec.children, `screens[${si}].sections[${ci}]`)));
    assert.ok(cut, 'the calculator fixture has a wired button to cut');

    const rec = validateAppDefinition(def).warnings.find((w) => w.code === 'component.control_inert');
    assert.ok(rec, 'the cut button is reported');
    assert.equal(rec.kind, 'app');
    assert.deepEqual(rec.targetRef, { kind: 'app', id: null, path: cut.path, nodeId: cut.id });
    assert.equal(rec.path, cut.path, 'the legacy path stays for existing callers');
    assert.equal(typeof rec.hint, 'string', 'the legacy hint stays for existing callers');

    const f = fromLegacy('app', rec, { id: 'app_calc', title: 'Calculator' });
    assert.equal(isFinding(f), true);
    assert.equal(f.targetRef.id, 'app_calc', 'the caller fills in the id the validator never saw');
    assert.equal(f.targetRef.nodeId, cut.id);
    assert.equal(f.remediation, rec.hint);
});

test('Routine validator: every record names the automation and, where the path has one, the step', () => {
    const { validateDefinitionStrict, validateDefinition } = require('../../automation/validate/definition');

    // A record about the graph itself: no step.
    const missing = validateDefinitionStrict({ steps: [], edges: [] }).errors.find((e) => e.code === 'trigger.missing');
    assert.equal(missing.kind, 'automation');
    assert.deepEqual(missing.targetRef, { kind: 'automation', id: null, path: 'trigger' });
    assert.equal(missing.severity, 'error', 'severity semantics are untouched');

    // A record about a top-level step: index path → step id.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 's_first', type: 'set', assignments: [] }, { id: 's_odd', type: 'no_such_type' }],
        edges: [],
        layers: {
            enrich: {
                trigger: { id: 'ltrg', kind: 'layer_input', params: [] },
                steps: [{ id: 'l_odd', type: 'no_such_type' }],
                edges: [],
            },
        },
    };
    const strict = validateDefinitionStrict(def);
    const odd = strict.errors.find((e) => e.code === 'step.unknown_type' && e.path === 'steps[1].type');
    assert.ok(odd, 'the unknown step type is reported at its index');
    assert.equal(odd.targetRef.stepId, 's_odd', 'an index path resolves to the step id');

    // A record inside a layer keeps the full path and resolves the layer's step.
    const layerOdd = strict.errors.find((e) => e.code === 'step.unknown_type' && e.path.startsWith('layers.enrich.'));
    assert.ok(layerOdd, 'the layer step is reported');
    assert.equal(layerOdd.targetRef.path, 'layers.enrich.steps[0].type');
    assert.equal(layerOdd.targetRef.stepId, 'l_odd');

    // opts.target threads the automation's identity through validateGraph.
    // (validate/definition.js does not forward it yet — until it does, every
    // record from validateDefinition carries id null and the caller fills it
    // in via fromLegacy's third argument.)
    const { validateGraph } = require('../../automation/validate/graph');
    const direct = { errors: [], warnings: [] };
    validateGraph({ steps: [], edges: [] }, '', { ...direct, target: { id: 'auto_7', title: 'Kredietcheck' } });
    assert.equal(direct.errors[0].code, 'trigger.missing');
    assert.deepEqual(direct.errors[0].targetRef, { kind: 'automation', id: 'auto_7', title: 'Kredietcheck', path: 'trigger' });

    // The draft/activate ladder is intact and its verdict converts as blockedAt.
    const draft = validateDefinition({
        trigger: { id: 'trg', kind: 'schedule', schedule: {} }, steps: [], edges: [],
    }, { stage: 'draft' });
    const ladder = draft.warnings.find((w) => w.code === 'trigger.schedule_missing');
    assert.ok(ladder, 'a completeness code is a warning at draft stage');
    assert.equal(ladder.blockedAt, 'activate');
    assert.equal(ladder.targetRef.stepId, 'trg', 'the trigger path resolves to the trigger id');
    const f = fromLegacy('automation', ladder, { id: 'auto_7' });
    assert.equal(f.blockedAt, 'activate');
    assert.equal(f.severity, 'warning');

    // Every record of both runs is convertible — no per-code exceptions.
    for (const rec of [...strict.errors, ...strict.warnings, ...draft.errors, ...draft.warnings]) {
        assert.ok(isFinding(fromLegacy('automation', rec)), `${rec.code} converts`);
    }
});

test('Routine validator: a nested step is addressed by its own id, and edge paths name no step', () => {
    const { validateDefinitionStrict } = require('../../automation/validate/definition');
    const loop = (edges) => ({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'lp', type: 'loop', collection: 'trigger.items', body: [{ id: 'inner', type: 'no_such_type' }] }],
        edges,
    });
    // The per-step walk only runs once ids and edges are sound, so the two
    // cases need two definitions.
    const inner = validateDefinitionStrict(loop([{ from: 'trg', to: 'lp' }])).errors.find((e) => e.code === 'loop.body_item_type');
    assert.ok(inner, 'the body step is reported');
    // The container is addressed by ID here (the per-step walk knows it), the
    // body step too — a top-level record uses the index instead. Both forms
    // resolve.
    assert.equal(inner.path, 'steps[lp].body.steps[inner]');
    assert.equal(inner.targetRef.stepId, 'inner', 'the deepest addressed node wins over its loop');

    const edge = validateDefinitionStrict(loop([{ from: 'ghost', to: 'lp' }])).errors.find((e) => e.code === 'edge.unknown_from');
    assert.ok(edge);
    assert.equal('stepId' in edge.targetRef, false, 'an edge path addresses no step');
    assert.equal(edge.targetRef.path, 'edges[0].from');
});

test('Solution graph: a problem is a Finding about the object that HOLDS the broken reference', () => {
    const { buildProjectGraph, PROBLEM, PROSE, SEVERITY } = require('../../projects/graph');
    assert.equal(typeof PROSE[PROBLEM.UNWIRED], 'function', 'PROSE stays exported');

    const g = buildProjectGraph({
        automations: [
            { id: 'a1', title: 'Kredietcheck', userId: 'alice', kind: 'automation', definition: { steps: [{ id: 'call_1', type: 'call_block', blockId: 'gone' }] } },
        ],
        apps: [{ id: 'app1', name: 'Offerteportaal', userId: 'alice', definition: { actions: { go: { kind: 'run_automation', automationId: null } } } }],
        webpages: [{ id: 'w1', name: 'Landing', userId: 'alice', bridgeGrants: { automations: [{ automationId: 'elsewhere' }] } }],
        knownAutomationIds: new Set(['elsewhere']),
    });

    const byCode = Object.fromEntries(g.problems.map((p) => [p.code, p]));
    assert.deepEqual(Object.keys(byCode).sort(), [PROBLEM.EXTERNAL, PROBLEM.MISSING, PROBLEM.UNWIRED]);

    const unwired = byCode[PROBLEM.UNWIRED];
    assert.equal(unwired.kind, 'app');
    assert.deepEqual(unwired.targetRef, { kind: 'app', id: 'app1', title: 'Offerteportaal' });
    assert.equal(unwired.severity, SEVERITY[PROBLEM.UNWIRED]);
    assert.equal(unwired.message, PROSE[PROBLEM.UNWIRED]('Offerteportaal'), 'the prose is rendered at construction');
    assert.equal(unwired.targetId, null, 'the graph\'s own fields are untouched');

    const missing = byCode[PROBLEM.MISSING];
    assert.equal(missing.kind, 'automation');
    assert.deepEqual(missing.targetRef, { kind: 'automation', id: 'a1', title: 'Kredietcheck', stepId: 'call_1' });
    assert.equal(missing.targetId, 'gone', 'targetId is still the routine pointed AT, not the Finding target');
    assert.equal(missing.severity, 'error');

    const external = byCode[PROBLEM.EXTERNAL];
    assert.deepEqual(external.targetRef, { kind: 'webpage', id: 'w1', title: 'Landing' });

    for (const p of g.problems) {
        const f = fromLegacy(p.kind, p);
        assert.ok(isFinding(f), `${p.code} converts`);
        assert.equal(f.message, p.message);
    }
});

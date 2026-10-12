/**
 * Follow the route (routeFollow.mjs): a step hanging off a Condition that
 * works through a list reads what that Condition keeps.
 *
 * Run: node --test shared/expr/routeFollow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isListRoute, routeListPath, routeOutputPaths, rebaseRefs, stepReadsPath,
    followRouteAround, followRouteEdit, staleSuccessors, followSuccessors,
    switchCaseChanges, relabelSwitchEdges,
} from './routeFollow.mjs';

const MESSAGES = 'steps.mc_read_many.output.messages';
const ATTACHMENTS = `${MESSAGES}[*].attachments`;
const ref = (path) => ({ kind: 'ref', path });

const readAttachment = (overRef = ATTACHMENTS, parentRef = MESSAGES) => ({
    id: 'mc_read_attachment', type: 'integration_action', label: 'Read attachment', tool: 'gmail_read_attachment',
    forEach: { overRef, itemVar: 'attachment', parents: [{ itemVar: 'message', overRef: parentRef }] },
    inputs: { messageId: ref('loop.attachment.messageId'), attachmentId: ref('loop.attachment.attachmentId') },
});

/** The demo "Fabrikam attachments by type" definition (agent-hub/src/demo/fixtures/automationsMailCondition.ts), its wiring only. */
function demoDefinition() {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'mc_search', type: 'integration_action', label: 'Search', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'from:fabrikam.example' } } },
            { id: 'mc_read_many', type: 'integration_action', label: 'Read many', tool: 'gmail_read_many', inputs: { messageIds: ref('steps.mc_search.output.results[*].id') } },
            { id: 'mc_condition', type: 'filter', label: 'Condition', arrayRef: MESSAGES, expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' },
            readAttachment(),
        ],
        edges: [
            { from: 'trg', to: 'mc_search' },
            { from: 'mc_search', to: 'mc_read_many' },
            { from: 'mc_read_many', to: 'mc_condition' },
            { from: 'mc_condition', to: 'mc_read_attachment' },
        ],
    };
}

const stepOf = (def, id) => def.steps.find((s) => s.id === id);
const listSwitch = (id, names, arrayRef = MESSAGES) => ({
    id, type: 'switch', label: 'Condition', arrayRef, routeStyle: 'rules',
    cases: names.map((name) => ({ name, expr: `equals(fileType(item), "${name}")` })),
});

// ── Basics ───────────────────────────────────────────────────────────────

test('isListRoute / routeListPath / routeOutputPaths', () => {
    const filter = { id: 'f', type: 'filter', arrayRef: MESSAGES, expr: 'true' };
    const sw = listSwitch('s', ['pdf', 'word']);
    assert.equal(isListRoute(filter), true);
    assert.equal(isListRoute(sw), true);
    assert.equal(isListRoute({ id: 'x', type: 'switch', expr: 'a', cases: [] }), false);
    assert.equal(isListRoute({ id: 'x', type: 'filter', arrayRef: '  ' }), false);
    assert.equal(isListRoute({ id: 'x', type: 'condition', expr: 'true' }), false);
    assert.equal(routeListPath(filter, { from: 'f', to: 't' }), 'steps.f.output.items');
    assert.equal(routeListPath(filter, { from: 'f', to: 't', label: 'on_error' }), null);
    assert.equal(routeListPath(sw, { from: 's', to: 't', label: 'case:word' }), 'steps.s.output.matchesByCase.word');
    assert.equal(routeListPath(sw, { from: 's', to: 't', label: 'case:default', caseName: 'default' }), 'steps.s.output.matchesByCase.default');
    assert.equal(routeListPath(sw, { from: 's', to: 't' }), null);
    assert.deepEqual(routeOutputPaths(filter), ['steps.f.output.items']);
    assert.deepEqual(routeOutputPaths(sw), ['steps.s.output.matchesByCase.pdf', 'steps.s.output.matchesByCase.word', 'steps.s.output.matchesByCase.default']);
});

// ── rebaseRefs ───────────────────────────────────────────────────────────

test('rebaseRefs: ref, template, expression, bare path and forEach parents', () => {
    const to = 'steps.c.output.items';
    const step = {
        id: 't', label: 'Uses steps.mc_read_many.output.messages', notes: MESSAGES,
        forEach: { overRef: ATTACHMENTS, itemVar: 'a', parents: [{ itemVar: 'm', overRef: MESSAGES }] },
        inputs: {
            r: ref(`${MESSAGES}[0].subject`),
            tpl: { kind: 'template', template: `First: {{ ${MESSAGES}[0].subject }} of {{ len(${MESSAGES}) }}` },
            ex: { kind: 'expr', expr: `len(${MESSAGES}) > 2 && contains(${MESSAGES}[*].from, "fabrikam")` },
            lit: { kind: 'literal', value: MESSAGES },
            other: ref('steps.mc_read_many.output.count'),
        },
        arrayRef: MESSAGES,
    };
    const { value, changed } = rebaseRefs(step, MESSAGES, to);
    assert.equal(changed, true);
    assert.equal(value.forEach.overRef, `${to}[*].attachments`);
    assert.equal(value.forEach.parents[0].overRef, to);
    assert.equal(value.inputs.r.path, `${to}[0].subject`);
    assert.equal(value.inputs.tpl.template, `First: {{ ${to}[0].subject }} of {{ len(${to}) }}`);
    assert.equal(value.inputs.ex.expr, `len(${to}) > 2 && contains(${to}[*].from, "fabrikam")`);
    assert.equal(value.arrayRef, to);
    // Untouched: literal bindings, names, notes, unrelated paths.
    assert.equal(value.inputs.lit.value, MESSAGES);
    assert.equal(value.label, step.label);
    assert.equal(value.notes, MESSAGES);
    assert.equal(value.inputs.other.path, 'steps.mc_read_many.output.count');
    // Pure: the input is unchanged.
    assert.equal(step.forEach.overRef, ATTACHMENTS);
});

test('rebaseRefs: quoted text untouched, bracket spelling matched, no change → same object', () => {
    const expr = `contains(steps["mc_read_many"].output.messages[*].subject, "steps.mc_read_many.output.messages") || 'steps.mc_read_many.output.messages' == "x"`;
    const { value, changed } = rebaseRefs({ expr }, MESSAGES, 'steps.c.output.items');
    assert.equal(changed, true);
    assert.equal(value.expr, `contains(steps.c.output.items[*].subject, "steps.mc_read_many.output.messages") || 'steps.mc_read_many.output.messages' == "x"`);
    const same = { expr: 'steps.other.output.messages' };
    const r = rebaseRefs(same, MESSAGES, 'steps.c.output.items');
    assert.equal(r.changed, false);
    assert.equal(r.value, same);
    // A prefix of a KEY is not a prefix of the path.
    assert.equal(rebaseRefs({ p: 'steps.mc_read_many.output.messagesCount' }, MESSAGES, 'steps.c.output.items').changed, false);
});

test('stepReadsPath', () => {
    assert.equal(stepReadsPath(readAttachment(), MESSAGES), true);
    assert.equal(stepReadsPath(readAttachment(), 'steps["mc_read_many"].output.messages'), true);
    assert.equal(stepReadsPath(readAttachment(), 'steps.mc_condition.output.items'), false);
    assert.equal(stepReadsPath({ notes: MESSAGES }, MESSAGES), false);
    assert.equal(stepReadsPath(readAttachment(), 'not a path ['), false);
});

// ── followRouteAround ────────────────────────────────────────────────────

test('followRouteAround: a filter inserted between Read many and Read attachment re-points Read attachment (W1)', () => {
    const def = demoDefinition();
    const { definition, rebound } = followRouteAround(def, 'mc_condition');
    const t = stepOf(definition, 'mc_read_attachment');
    assert.equal(t.forEach.overRef, 'steps.mc_condition.output.items[*].attachments');
    assert.deepEqual(t.forEach.parents, [{ itemVar: 'message', overRef: 'steps.mc_condition.output.items' }]);
    assert.deepEqual(rebound, [{ stepId: 'mc_read_attachment', from: MESSAGES, to: 'steps.mc_condition.output.items' }]);
    // Only the successor is touched; the input definition is unchanged.
    assert.equal(stepOf(definition, 'mc_read_many'), stepOf(def, 'mc_read_many'));
    assert.equal(stepOf(def, 'mc_read_attachment').forEach.overRef, ATTACHMENTS);
});

test('followRouteAround: a step added after case pdf reads matchesByCase.pdf, also when auto-map picked another output (W2)', () => {
    const def = {
        steps: [
            listSwitch('sw', ['pdf', 'word']),
            { id: 'n', type: 'integration_action', forEach: { overRef: 'steps.sw.output.matchesByCase.word', itemVar: 'f' }, inputs: { a: ref(`${MESSAGES}[0].id`) } },
        ],
        edges: [{ from: 'sw', to: 'n', label: 'case:pdf', caseName: 'pdf' }],
    };
    const { definition, rebound } = followRouteAround(def, 'n');
    const n = stepOf(definition, 'n');
    assert.equal(n.forEach.overRef, 'steps.sw.output.matchesByCase.pdf');
    assert.equal(n.inputs.a.path, 'steps.sw.output.matchesByCase.pdf[0].id');
    assert.equal(rebound.length, 2);
});

test('followRouteAround: a step on Otherwise reads matchesByCase.default; a non-route predecessor changes nothing', () => {
    const def = {
        steps: [listSwitch('sw', ['pdf']), { id: 'n', type: 'loop', overRef: MESSAGES, itemVar: 'm', steps: [] }],
        edges: [{ from: 'sw', to: 'n', label: 'case:default' }],
    };
    const { definition } = followRouteAround(def, 'n');
    assert.equal(stepOf(definition, 'n').overRef, 'steps.sw.output.matchesByCase.default');

    const plain = { steps: [{ id: 'a', type: 'condition', expr: 'true' }, { id: 'n', overRef: MESSAGES }], edges: [{ from: 'a', to: 'n', label: 'then' }] };
    const r = followRouteAround(plain, 'n');
    assert.equal(r.definition, plain);
    assert.deepEqual(r.rebound, []);
    assert.deepEqual(followRouteAround(plain, 'missing').rebound, []);
});

test('followRouteAround: on_error edges are not a route', () => {
    const def = {
        steps: [{ id: 'f', type: 'filter', arrayRef: MESSAGES, expr: 'true' }, { id: 'n', overRef: MESSAGES }],
        edges: [{ from: 'f', to: 'n', label: 'on_error' }],
    };
    assert.deepEqual(followRouteAround(def, 'f').rebound, []);
});

// ── followRouteEdit ──────────────────────────────────────────────────────

function routedDefinition(route, edge, readerRef) {
    return {
        steps: [route, { id: 't', type: 'integration_action', forEach: { overRef: readerRef, itemVar: 'x' } }],
        edges: [{ from: route.id, to: 't', ...edge }],
    };
}

test('followRouteEdit: filter → switch moves items to the first output; switch → filter moves it back (W3)', () => {
    const filter = { id: 'c', type: 'filter', arrayRef: MESSAGES, expr: 'true' };
    const sw = listSwitch('c', ['pdf', 'word']);
    const toSwitch = followRouteEdit(routedDefinition(sw, { label: 'case:pdf', caseName: 'pdf' }, 'steps.c.output.items'), 'c', filter);
    assert.equal(stepOf(toSwitch.definition, 't').forEach.overRef, 'steps.c.output.matchesByCase.pdf');
    assert.deepEqual(toSwitch.rebound, [{ stepId: 't', from: 'steps.c.output.items', to: 'steps.c.output.matchesByCase.pdf' }]);

    const toFilter = followRouteEdit(routedDefinition(filter, {}, 'steps.c.output.matchesByCase.pdf[*].x'), 'c', sw);
    assert.equal(stepOf(toFilter.definition, 't').forEach.overRef, 'steps.c.output.items[*].x');
});

test('followRouteEdit: one output ↔ one-case list switch (keep the rest, BFSF-485 F2)', () => {
    const filter = { id: 'c', type: 'filter', arrayRef: MESSAGES, expr: 'contains(item.from, "fabrikam")' };
    const keepRest = { id: 'c', type: 'switch', arrayRef: MESSAGES, routeStyle: 'rules', cases: [{ name: 'Output 1', expr: filter.expr }] };
    const on = followRouteEdit(routedDefinition(keepRest, { label: 'case:Output 1', caseName: 'Output 1' }, 'steps.c.output.items'), 'c', filter);
    assert.equal(stepOf(on.definition, 't').forEach.overRef, 'steps.c.output.matchesByCase["Output 1"]');
    const off = followRouteEdit(routedDefinition(filter, {}, 'steps.c.output.matchesByCase["Output 1"]'), 'c', keepRest);
    assert.equal(stepOf(off.definition, 't').forEach.overRef, 'steps.c.output.items');
});

test('followRouteEdit: a whole-run Condition turned into a filter re-points the loop after it (BFSF-485 F4)', () => {
    const RESULTS = 'steps.s.output.results';
    const whole = { id: 'c', type: 'condition', label: 'Condition', expr: `contains(${RESULTS}[*].name, "x")` };
    const filter = { id: 'c', type: 'filter', label: 'Condition', arrayRef: RESULTS, expr: 'contains(item.name, "x")' };
    const loop = {
        id: 't', type: 'integration_action', label: 'Read',
        forEach: { overRef: RESULTS, itemVar: 'r', parents: [{ itemVar: 'p', overRef: 'steps.s.output.pages' }] },
        inputs: { name: ref(`${RESULTS}[0].name`), other: ref('steps.s.output.pages') },
    };
    const later = { id: 'u', type: 'integration_action', label: 'Later', forEach: { overRef: RESULTS, itemVar: 'r' } };
    const def = {
        steps: [{ id: 's', type: 'integration_action' }, filter, loop, later],
        edges: [{ from: 's', to: 'c' }, { from: 'c', to: 't', label: 'true' }, { from: 't', to: 'u' }],
    };
    const { definition, rebound } = followRouteEdit(def, 'c', whole);
    const t = stepOf(definition, 't');
    assert.equal(t.forEach.overRef, 'steps.c.output.items');
    assert.equal(t.inputs.name.path, 'steps.c.output.items[0].name');
    assert.equal(t.inputs.other.path, 'steps.s.output.pages');
    assert.deepEqual(rebound, [{ stepId: 't', from: RESULTS, to: 'steps.c.output.items' }]);
    // Only direct successors; the route itself keeps its own list.
    assert.equal(stepOf(definition, 'u'), later);
    assert.equal(stepOf(definition, 'c'), filter);
    assert.equal(def.steps[2].forEach.overRef, RESULTS, 'input not mutated');
});

test('followRouteEdit: a switch without a list turned into a list switch re-points each output (F4)', () => {
    const before = { id: 'c', type: 'switch', label: 'Condition', routeStyle: 'rules', cases: [{ name: 'pdf', expr: 'true' }] };
    const after = listSwitch('c', ['pdf']);
    const def = {
        steps: [after, { id: 'a', forEach: { overRef: MESSAGES } }, { id: 'b', forEach: { overRef: MESSAGES } }],
        edges: [{ from: 'c', to: 'a', label: 'case:pdf', caseName: 'pdf' }, { from: 'c', to: 'b', label: 'case:default', caseName: 'default' }],
    };
    const { definition } = followRouteEdit(def, 'c', before);
    assert.equal(stepOf(definition, 'a').forEach.overRef, 'steps.c.output.matchesByCase.pdf');
    assert.equal(stepOf(definition, 'b').forEach.overRef, 'steps.c.output.matchesByCase.default');
});

test('followRouteEdit: a list route turned back into a whole-run Condition points its readers back at the list', () => {
    const filter = { id: 'c', type: 'filter', arrayRef: MESSAGES, expr: 'true' };
    const whole = { id: 'c', type: 'condition', expr: 'true' };
    const def = routedDefinition(whole, { label: 'true' }, 'steps.c.output.items');
    def.steps.push({ id: 'u', inputs: { first: ref('steps.c.output.items[0].id') } });
    const { definition, rebound } = followRouteEdit(def, 'c', filter);
    assert.equal(stepOf(definition, 't').forEach.overRef, MESSAGES);
    assert.equal(stepOf(definition, 'u').inputs.first.path, `${MESSAGES}[0].id`);
    assert.equal(stepOf(definition, 'c'), whole);
    assert.deepEqual(rebound, [
        { stepId: 't', from: 'steps.c.output.items', to: MESSAGES },
        { stepId: 'u', from: 'steps.c.output.items', to: MESSAGES },
    ]);
});

test('followRouteEdit: a list switch that stops working through a list hands every output back to the list', () => {
    const before = listSwitch('c', ['pdf', 'word']);
    const after = { ...before, arrayRef: undefined };
    const def = {
        steps: [after, { id: 'a', forEach: { overRef: 'steps.c.output.matchesByCase.word[*].attachments' } }, { id: 'b', overRef: 'steps.c.output.matchesByCase.default' }],
        edges: [{ from: 'c', to: 'a', label: 'case:word', caseName: 'word' }],
    };
    const { definition } = followRouteEdit(def, 'c', before);
    assert.equal(stepOf(definition, 'a').forEach.overRef, ATTACHMENTS);
    assert.equal(stepOf(definition, 'b').overRef, MESSAGES);
});

test('followRouteEdit: renaming an output rewrites every step (W4); the route itself is left alone', () => {
    const before = listSwitch('c', ['pdf', 'word']);
    const after = listSwitch('c', ['invoices', 'word']);
    const def = {
        steps: [after, { id: 'a', overRef: 'steps.c.output.matchesByCase.pdf' }, { id: 'b', inputs: { x: ref('steps.c.output.matchesByCase.word') } }],
        edges: [{ from: 'c', to: 'a', label: 'case:invoices', caseName: 'invoices' }],
    };
    const { definition, rebound } = followRouteEdit(def, 'c', before);
    assert.equal(stepOf(definition, 'a').overRef, 'steps.c.output.matchesByCase.invoices');
    assert.equal(stepOf(definition, 'b'), def.steps[2]);
    assert.equal(stepOf(definition, 'c'), after);
    assert.deepEqual(rebound, [{ stepId: 'a', from: 'steps.c.output.matchesByCase.pdf', to: 'steps.c.output.matchesByCase.invoices' }]);
});

/** Steps rp / rw / rx reading the pdf / word / excel output of list switch `c`, each on its own edge. */
function caseReaders(route) {
    const reader = (id, name) => ({ id, forEach: { overRef: `steps.c.output.matchesByCase.${name}`, itemVar: 'x' } });
    return {
        steps: [route, reader('rp', 'pdf'), reader('rw', 'word'), reader('rx', 'excel')],
        edges: ['pdf', 'word', 'excel'].map((name) => ({ from: 'c', to: `r${name[0]}`, label: `case:${name}`, caseName: name })),
    };
}
const readsOf = (def) => Object.fromEntries(def.steps.slice(1).map((s) => [s.id, s.forEach.overRef.split('.').pop()]));

test('followRouteEdit: reordering a switch\'s outputs moves no reader (each keeps its own output)', () => {
    const before = listSwitch('c', ['pdf', 'word', 'excel']);
    const def = caseReaders(listSwitch('c', ['word', 'pdf', 'excel']));
    const r = followRouteEdit(def, 'c', before);
    assert.equal(r.definition, def);
    assert.deepEqual(r.rebound, []);
});

test('followRouteEdit: removing or adding a case never shifts a reader onto a neighbour', () => {
    const before = listSwitch('c', ['pdf', 'word', 'excel']);
    for (const names of [['word', 'excel'], ['pdf', 'excel'], ['pdf', 'new', 'word', 'excel']]) {
        const r = followRouteEdit(caseReaders(listSwitch('c', names)), 'c', before);
        assert.deepEqual(readsOf(r.definition), { rp: 'pdf', rw: 'word', rx: 'excel' }, names.join(','));
        assert.deepEqual(r.rebound, [], names.join(','));
    }
});

test('followRouteEdit: a removed case plus a deeper list still collapses the outputs that remain, by name', () => {
    const before = listSwitch('c', ['pdf', 'word']);
    const after = listSwitch('c', ['word'], ATTACHMENTS);
    const def = routedDefinition(after, { label: 'case:word', caseName: 'word' }, 'steps.c.output.matchesByCase.word[*].attachments');
    assert.equal(stepOf(followRouteEdit(def, 'c', before).definition, 't').forEach.overRef, 'steps.c.output.matchesByCase.word');
});

test('switchCaseChanges: a rename is a name changed in place; reorders, adds and removals keep names', () => {
    const cases = (...names) => names.map((name) => ({ name }));
    const diff = (a, b) => {
        const { renames, removed } = switchCaseChanges(cases(...a), cases(...b));
        return { renames: Object.fromEntries(renames), removed: [...removed] };
    };
    assert.deepEqual(diff(['pdf', 'word'], ['invoices', 'word']), { renames: { pdf: 'invoices' }, removed: [] });
    assert.deepEqual(diff(['pdf', 'word'], ['word', 'pdf']), { renames: {}, removed: [] });
    assert.deepEqual(diff(['pdf', 'word', 'excel'], ['word', 'excel']), { renames: {}, removed: ['pdf'] });
    assert.deepEqual(diff(['pdf', 'word'], ['pdf', 'new', 'word']), { renames: {}, removed: [] });
    assert.deepEqual(diff(['vip', 'normal'], ['normal', 'normal']), { renames: {}, removed: ['vip'] });
    const junk = switchCaseChanges(null, [{ name: '' }, null]);
    assert.deepEqual([junk.renames.size, junk.removed.size], [0, 0]);
});

test('relabelSwitchEdges: renames move edges and defaultBranch, removals drop them, reorders change nothing', () => {
    const cases = (...names) => names.map((name) => ({ name }));
    const def = {
        steps: [{ id: 'c', type: 'switch', defaultBranch: 'pdf' }, { id: 'o', type: 'switch', defaultBranch: 'pdf' }],
        edges: [
            { from: 'c', to: 'a', label: 'case:pdf' },
            { from: 'c', to: 'b', caseName: 'word' },
            { from: 'c', to: 'z', label: 'case:default', caseName: 'default' },
            { from: 'o', to: 'a', label: 'case:pdf', caseName: 'pdf' },
        ],
    };
    const renamed = relabelSwitchEdges(def, 'c', cases('pdf', 'word'), cases('invoices', 'word'));
    assert.deepEqual(renamed.edges[0], { from: 'c', to: 'a', label: 'case:invoices', caseName: 'invoices' });
    assert.equal(renamed.edges[1], def.edges[1]);
    assert.equal(renamed.edges[3], def.edges[3], 'another switch is not touched');
    assert.equal(renamed.steps[0].defaultBranch, 'invoices');
    assert.equal(renamed.steps[1], def.steps[1]);
    const removed = relabelSwitchEdges(def, 'c', cases('pdf', 'word'), cases('word'));
    assert.deepEqual(removed.edges.map((e) => e.to), ['b', 'z', 'a']);
    assert.equal(removed.steps[0].defaultBranch, null);
    assert.equal(relabelSwitchEdges(def, 'c', cases('pdf', 'word'), cases('word', 'pdf')), def);
    assert.equal(relabelSwitchEdges(null, 'c', [], []), null);
});

test('followRouteEdit: a list one level deeper collapses [*].k and prunes the parents that no longer fit (W5)', () => {
    const before = { id: 'c', type: 'filter', arrayRef: MESSAGES, expr: 'true' };
    const after = { id: 'c', type: 'filter', arrayRef: ATTACHMENTS, expr: 'true' };
    const def = routedDefinition(after, {}, 'steps.c.output.items[*].attachments');
    def.steps[1].forEach.parents = [{ itemVar: 'message', overRef: 'steps.c.output.items' }];
    const { definition } = followRouteEdit(def, 'c', before);
    const t = stepOf(definition, 't');
    assert.equal(t.forEach.overRef, 'steps.c.output.items');
    assert.equal('parents' in t.forEach, false);
});

test('followRouteEdit: deeper list and filter → switch in one edit collapse the old output too', () => {
    const before = { id: 'c', type: 'filter', arrayRef: MESSAGES, expr: 'true' };
    const after = listSwitch('c', ['pdf'], ATTACHMENTS);
    const def = routedDefinition(after, { label: 'case:pdf', caseName: 'pdf' }, 'steps.c.output.items[*].attachments');
    const { definition } = followRouteEdit(def, 'c', before);
    assert.equal(stepOf(definition, 't').forEach.overRef, 'steps.c.output.matchesByCase.pdf');
});

test('followRouteEdit: any other change of list rewrites nothing', () => {
    const before = { id: 'c', type: 'filter', arrayRef: MESSAGES, expr: 'true' };
    const after = { id: 'c', type: 'filter', arrayRef: 'steps.other.output.rows', expr: 'true' };
    const def = routedDefinition(after, {}, 'steps.c.output.items[*].attachments');
    const r = followRouteEdit(def, 'c', before);
    assert.equal(r.definition, def);
    assert.deepEqual(r.rebound, []);
    assert.deepEqual(followRouteEdit(def, 'c', null).rebound, []);
});

// ── staleSuccessors / followSuccessors ───────────────────────────────────

test('staleSuccessors on the demo definition: Read attachment; none after followSuccessors (W7)', () => {
    const def = demoDefinition();
    assert.deepEqual(staleSuccessors(def, 'mc_condition'), [
        { stepId: 'mc_read_attachment', reads: MESSAGES, to: 'steps.mc_condition.output.items' },
    ]);
    const { definition, rebound } = followSuccessors(def, 'mc_condition', ['mc_read_attachment']);
    assert.equal(rebound.length, 1);
    assert.deepEqual(staleSuccessors(definition, 'mc_condition'), []);
    assert.equal(stepOf(definition, 'mc_read_attachment').forEach.overRef, 'steps.mc_condition.output.items[*].attachments');
});

test('staleSuccessors: a successor that reads an output as well is not stale; followSuccessors only touches the chosen steps', () => {
    const def = demoDefinition();
    def.steps[3].inputs.count = ref('steps.mc_condition.output.items');
    assert.deepEqual(staleSuccessors(def, 'mc_condition'), []);
    const other = demoDefinition();
    const r = followSuccessors(other, 'mc_condition', ['someone_else']);
    assert.equal(r.definition, other);
    assert.deepEqual(staleSuccessors(other, 'mc_read_many'), []);
    assert.deepEqual(followSuccessors(other, 'mc_read_many', ['mc_condition']).rebound, []);
});

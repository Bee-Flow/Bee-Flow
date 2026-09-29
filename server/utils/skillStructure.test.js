/**
 * skillStructure — parsers, renderers, validators and the precedence rule.
 *
 * Run: cd server && node --test utils/skillStructure.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const S = require('./skillStructure');

const seq = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };

// ── workflow → steps ─────────────────────────────────────────────────
test('numbered workflow lines become ordered steps with empty refs', () => {
    const steps = S.parseWorkflowToSteps('1. Read the request\n2. Look up the price list\n3) Draft the quote', { idFactory: seq('s') });
    assert.deepStrictEqual(steps, [
        { id: 's1', text: 'Read the request', refs: [] },
        { id: 's2', text: 'Look up the price list', refs: [] },
        { id: 's3', text: 'Draft the quote', refs: [] },
    ]);
});

test('bullets, "Step n:" prefixes and continuation lines are handled', () => {
    const steps = S.parseWorkflowToSteps('- First thing\n  that continues here\n* Second thing\nStap 3: Derde ding', { idFactory: seq('s') });
    assert.deepStrictEqual(steps.map(s => s.text), ['First thing that continues here', 'Second thing', 'Derde ding']);
});

test('a marker-less paragraph becomes one step per line; empty text becomes no steps', () => {
    assert.deepStrictEqual(S.parseWorkflowToSteps('Check\n\nWrite', { idFactory: seq('s') }).map(s => s.text), ['Check', 'Write']);
    assert.deepStrictEqual(S.parseWorkflowToSteps(''), []);
    assert.deepStrictEqual(S.parseWorkflowToSteps(null), []);
});

test('rendering steps back gives the numbered list a person would type', () => {
    const steps = S.parseWorkflowToSteps('1. A\n2. B', { idFactory: seq('s') });
    assert.strictEqual(S.renderStepsToWorkflow(steps), '1. A\n2. B');
});

// ── rules → rules_v2 ─────────────────────────────────────────────────
test('rules get polarity from their wording (niet/geen/nooit/never/don\'t → never)', () => {
    const rules = S.parseRulesToRulesV2('- Always answer in Dutch\n- Never share prices without VAT\n- Gebruik geen jargon\n- Noem nooit een concurrent\n- Don\'t guess', { idFactory: seq('r') });
    assert.deepStrictEqual(rules.map(r => [r.id, r.polarity]), [
        ['r1', 'must'], ['r2', 'never'], ['r3', 'never'], ['r4', 'never'], ['r5', 'never'],
    ]);
    assert.strictEqual(rules[1].text, 'Never share prices without VAT');
});

test('a single paragraph of rules is split into sentences', () => {
    const rules = S.parseRulesToRulesV2('Be brief. Do not invent figures. Quote the source.', { idFactory: seq('r') });
    assert.deepStrictEqual(rules.map(r => r.text), ['Be brief.', 'Do not invent figures.', 'Quote the source.']);
    assert.deepStrictEqual(rules.map(r => r.polarity), ['must', 'never', 'must']);
});

test('rendering rules back gives a bulleted list, and a ban is rendered AS a ban', () => {
    // The bullet is the whole prompt: `skillInjection` writes it after
    // "Rules:" and `skillTest` under "RULES THE ANSWER MUST RESPECT". A
    // `never` rule rendered bare reads there as an instruction to DO the
    // thing, which is how "Noem de interne kortingscode" + the ban mark used
    // to reach the model as an order to name the code.
    assert.strictEqual(
        S.renderRulesToText([{ id: 'a', polarity: 'must', text: 'One' }, { id: 'b', polarity: 'never', text: 'Two' }]),
        '- One\n- Never: Two',
    );
    // A sentence that already says it keeps its own words — no "Never: Never".
    assert.strictEqual(
        S.renderRulesToText([{ id: 'a', polarity: 'never', text: 'Never guess a price' }]),
        '- Never guess a price',
    );
});

test('a ban survives the round trip structure → text → structure', () => {
    // The second leg of the same defect: mobile sends the six TEXT fields on
    // every save, so a rules column that lost the ban re-parsed as `must` and
    // erased the mark in the database too.
    const banned = [{ id: 'r1', polarity: 'never', text: 'Noem de interne kortingscode' }];
    const text = S.renderRulesToText(banned);
    const back = S.parseRulesToRulesV2(text, { idFactory: seq('r') });
    assert.deepStrictEqual(back.map(r => [r.polarity, r.text]), [['never', 'Noem de interne kortingscode']]);
    // And through the write path a PUT actually takes.
    const w = S.resolveBodyWrite({ rulesV2: banned });
    assert.strictEqual(w.rules, '- Never: Noem de interne kortingscode');
    assert.deepStrictEqual(S.resolveBodyWrite({ rules: w.rules }).rulesV2.map(r => [r.polarity, r.text]),
        [['never', 'Noem de interne kortingscode']]);
});

// ── examples → examples_v2 ───────────────────────────────────────────
test('the Input:/Output: pattern becomes one example, with Why: and Not like this: picked up', () => {
    const ex = S.parseExamplesToExamplesV2('Input: How much is a window?\nOutput: A standard window is €450 ex VAT.\nWhy: The price list leads.\nNot like this: About 400 I think.', { idFactory: seq('e') });
    assert.deepStrictEqual(ex, [{
        id: 'e1',
        question: 'How much is a window?',
        good: 'A standard window is €450 ex VAT.',
        rationale: 'The price list leads.',
        bad: 'About 400 I think.',
    }]);
});

test('multiple Vraag:/Antwoord: pairs become multiple examples; multi-line answers are kept', () => {
    const ex = S.parseExamplesToExamplesV2('Vraag: A?\nAntwoord: Yes.\nSecond line.\n\nVraag: B?\nAntwoord: No.', { idFactory: seq('e') });
    assert.strictEqual(ex.length, 2);
    assert.strictEqual(ex[0].good, 'Yes.\nSecond line.');
    assert.strictEqual(ex[1].question, 'B?');
});

test('text without the pattern becomes ONE example whose good answer is the whole text', () => {
    const ex = S.parseExamplesToExamplesV2('Just some prose about tone.', { idFactory: seq('e') });
    assert.deepStrictEqual(ex, [{ id: 'e1', question: '', good: 'Just some prose about tone.', rationale: '' }]);
    assert.deepStrictEqual(S.parseExamplesToExamplesV2(''), []);
});

test('rendering examples back uses the same labels the parser reads (round trip)', () => {
    const text = 'Input: Q1\nOutput: A1\nWhy: R1\nNot like this: B1\n\nInput: Q2\nOutput: A2';
    const ex = S.parseExamplesToExamplesV2(text, { idFactory: seq('e') });
    assert.strictEqual(S.renderExamplesToText(ex), text);
    const again = S.parseExamplesToExamplesV2(S.renderExamplesToText(ex), { idFactory: seq('e') });
    assert.deepStrictEqual(again.map(({ id, ...rest }) => rest), ex.map(({ id, ...rest }) => rest));
});

// ── validators ───────────────────────────────────────────────────────
test('a string in a structured column is a 400, never parsed', () => {
    for (const [fn, field] of [[S.validateSteps, 'steps'], [S.validateRules, 'rulesV2'], [S.validateExamples, 'examplesV2']]) {
        assert.throws(() => fn('1. one\n2. two'), (e) => e instanceof S.SkillStructureError && e.status === 400 && e.field === field && /not a string/.test(e.message));
    }
    assert.throws(() => S.validateOutputSchema('{"type":"object"}'), (e) => e.status === 400 && e.field === 'outputSchema');
    assert.throws(() => S.validateIdList('kb1', 'knowledgeBaseIds'), (e) => e.status === 400);
});

test('validateSteps keeps ids, mints missing ones, dedupes refs and rejects unknown ref kinds', () => {
    const [a, b] = S.validateSteps([
        { id: 'keep', text: ' Look up ', refs: [{ kind: 'table', id: 't1' }, { kind: 'table', id: 't1' }, { kind: 'kb', id: 'k1' }] },
        { text: 'No id' },
    ]);
    assert.strictEqual(a.id, 'keep');
    assert.strictEqual(a.text, 'Look up');
    assert.deepStrictEqual(a.refs, [{ kind: 'table', id: 't1' }, { kind: 'kb', id: 'k1' }]);
    assert.match(b.id, /^step_[0-9a-f]{8}$/);
    assert.deepStrictEqual(b.refs, []);
    assert.throws(() => S.validateSteps([{ text: 'x', refs: [{ kind: 'agent', id: 'a' }] }]), /kind must be one of/);
    assert.throws(() => S.validateSteps([{ id: 'dup', text: 'x' }, { id: 'dup', text: 'y' }]), /duplicated/);
    assert.throws(() => S.validateSteps([{ text: 42 }]), /text must be a string/);
});

test('validateRules defaults polarity from the wording and rejects a bad polarity', () => {
    const [r] = S.validateRules([{ text: 'Never guess' }]);
    assert.strictEqual(r.polarity, 'never');
    assert.throws(() => S.validateRules([{ text: 'x', polarity: 'maybe' }]), /polarity/);
});

test('validateExamples keeps the optional fields only when present', () => {
    const [ex] = S.validateExamples([{ question: 'q', good: 'g', bad: '', violatedRuleId: 'rule_1', sourceConversationId: 'c1' }]);
    assert.deepStrictEqual(ex, { id: ex.id, question: 'q', good: 'g', rationale: '', violatedRuleId: 'rule_1', sourceConversationId: 'c1' });
    assert.ok(!('bad' in ex));
});

test('validateOutputSchema normalises to the ai_step.outputSchema shape and null means "no fields"', () => {
    assert.strictEqual(S.validateOutputSchema(undefined), null);
    assert.strictEqual(S.validateOutputSchema(null), null);
    assert.strictEqual(S.validateOutputSchema({ type: 'object', properties: {} }), null);
    const schema = S.validateOutputSchema({
        properties: {
            amount: { type: 'number', title: 'Bedrag', 'x-unit': '€', junk: 'dropped' },
            items: { type: 'array', items: { type: 'string' } },
            when: { type: 'string', format: 'date' },
        },
        required: ['amount', 'nope'],
    });
    assert.deepStrictEqual(schema, {
        type: 'object',
        properties: {
            amount: { type: 'number', title: 'Bedrag', 'x-unit': '€' },
            items: { type: 'array', items: { type: 'string' } },
            when: { type: 'string', format: 'date' },
        },
        required: ['amount'],
    });
    assert.throws(() => S.validateOutputSchema({ properties: { 'bad key': { type: 'string' } } }), /not a valid field key/);
    assert.throws(() => S.validateOutputSchema({ properties: { x: { type: 'date' } } }), /type must be one of/);
    assert.throws(() => S.validateOutputSchema({ type: 'array' }), /type must be 'object'/);
});

test('an option list survives — enum is what makes a field a choice downstream', () => {
    // mapping/fieldKinds.expectedKindFor reads type, format, enum and
    // items.type. Dropping enum would turn a skill's dropdown into text.
    const schema = S.validateOutputSchema({ properties: { status: { type: 'string', enum: ['open', 'closed', 42, { no: 1 }] } } });
    assert.deepStrictEqual(schema.properties.status, { type: 'string', enum: ['open', 'closed', 42] });
    const none = S.validateOutputSchema({ properties: { status: { type: 'string', enum: [] } } });
    assert.deepStrictEqual(none.properties.status, { type: 'string' }, 'an empty option list is no option list');
});

test('validateIdList trims, dedupes and rejects non-strings', () => {
    assert.deepStrictEqual(S.validateIdList([' a ', 'a', 'b', ''], 'x'), ['a', 'b']);
    assert.deepStrictEqual(S.validateIdList(undefined, 'x'), []);
    assert.throws(() => S.validateIdList([1], 'x'), /must be a string/);
});

// ── precedence rule ──────────────────────────────────────────────────
test('text-only body: text is stored as sent AND parsed into structure', () => {
    const w = S.resolveBodyWrite({ workflow: '1. A\n2. B', rules: 'Never guess', examples: 'Input: q\nOutput: a' }, { idFactory: seq('x') });
    assert.strictEqual(w.workflow, '1. A\n2. B');
    assert.deepStrictEqual(w.steps.map(s => s.text), ['A', 'B']);
    assert.deepStrictEqual(w.rulesV2.map(r => r.polarity), ['never']);
    assert.strictEqual(w.examplesV2[0].question, 'q');
});

test('structured body: text is regenerated from the structure, per facet', () => {
    const w = S.resolveBodyWrite({ steps: [{ id: 's1', text: 'A' }, { id: 's2', text: 'B' }], workflow: 'stale text that loses' });
    assert.strictEqual(w.workflow, '1. A\n2. B');
    assert.strictEqual(w.steps.length, 2);
    // Facets not sent are absent — the store must leave them untouched.
    assert.ok(!('rules' in w) && !('rulesV2' in w) && !('examples' in w) && !('examplesV2' in w));
});

test('a facet that was not sent is absent (never regenerated from stored structure)', () => {
    assert.deepStrictEqual(S.resolveBodyWrite({ name: 'only a rename' }), {});
    assert.deepStrictEqual(S.resolveBodyWrite({}), {});
});

test('null structure clears both columns; null text clears both columns', () => {
    const a = S.resolveBodyWrite({ steps: null });
    assert.deepStrictEqual(a, { steps: [], workflow: '' });
    const b = S.resolveBodyWrite({ rules: null });
    assert.deepStrictEqual(b, { rules: '', rulesV2: [] });
});

test('a string in a structured field of the body is a 400 through resolveBodyWrite too', () => {
    assert.throws(() => S.resolveBodyWrite({ steps: '1. A' }), (e) => e.status === 400 && e.field === 'steps');
    assert.throws(() => S.resolveBodyWrite({ workflow: { nope: true } }), (e) => e.status === 400 && e.field === 'workflow');
});

// ── helpers for the runtime adapter ──────────────────────────────────
test('tableRefsOf / refIdsOf collect refs across steps, deduped', () => {
    const steps = [
        { id: 'a', text: 'x', refs: [{ kind: 'table', id: 't1' }, { kind: 'kb', id: 'k1' }] },
        { id: 'b', text: 'y', refs: [{ kind: 'table', id: 't1' }, { kind: 'automation', id: 'au1' }] },
    ];
    assert.deepStrictEqual(S.tableRefsOf(steps), [{ id: 't1', scope: 'own', readOnly: true }]);
    assert.deepStrictEqual(S.refIdsOf(steps, 'kb'), ['k1']);
    assert.deepStrictEqual(S.refIdsOf(steps, 'automation'), ['au1']);
    assert.deepStrictEqual(S.tableRefsOf(null), []);
});

test('textOrRender prefers stored text and only renders when the text is empty', () => {
    assert.strictEqual(S.textOrRender('keep me', [{ text: 'no' }], S.renderStepsToWorkflow), 'keep me');
    assert.strictEqual(S.textOrRender('', [{ text: 'A' }], S.renderStepsToWorkflow), '1. A');
    assert.strictEqual(S.textOrRender('', [], S.renderStepsToWorkflow), '');
});

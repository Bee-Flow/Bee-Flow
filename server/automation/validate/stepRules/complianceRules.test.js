/**
 * findings-on-canvas — the compliance findings a definition can justify BY
 * ITSELF, proven to land on the step that causes them and to never block a
 * save.
 *
 * Every test here goes through `validateDefinition`, not through the rule
 * functions, because the thing being delivered is the record the builder
 * receives: its code, its severity, and a `path` the canvas can map back to a
 * node (agent-hub flow/matchValidationToStep.js matches by step id substring).
 *
 * Every test that asserts SILENCE carries a positive control in the same case
 * — the one change that should make it speak. An assertion that a code is
 * absent passes on a codebase where the rule does not exist at all, so on its
 * own it proves nothing and would go on passing if the rule were deleted; with
 * the control, each test fails both when the rule stops firing and when it
 * starts over-firing, which is the whole risk here. A compliance warning that
 * cries wolf is one people learn to skip.
 *
 * Run: node --test --test-force-exit automation/validate/stepRules/complianceRules.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('../../validate');
const { SHIELD_TYPES } = require('./complianceRules');
const dataFlow = require('../../../core/privacy/dataFlow');
const { AI_STEP_TYPES } = require('../../automationGraph');
const { VALID_STEP_TYPES } = require('../constants');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const findRec = (r, code) => [...r.errors, ...r.warnings].find(x => x.code === code);

/** A definition whose steps run one after another, in the order given. */
const def = (steps, extra = {}) => ({
    trigger: trigger(),
    steps,
    edges: steps.map((s, i) => ({ from: i === 0 ? 'trg' : steps[i - 1].id, to: s.id })),
    ...extra,
});

const post = (id, body) => ({ id, type: 'http_request', url: 'https://api.example.com/tickets', method: 'POST', body });
const mail = (id, inputs) => ({ id, type: 'integration_action', tool: 'gmail_compose', inputs });
const ref = (path) => ({ kind: 'ref', path });
const extract = (id, fields, source = 'steps.read.output.content') => ({
    id, type: 'data_extraction', source: ref(source), fields,
});

// ── 1. Personal data leaving the workspace ──────────────────────────────────

test('an HTTP request whose body carries a personal field is warned about, on that field', () => {
    const r = validateDefinition(def([post('t1', 'Klant: {{trigger.output.customer_name}}')]));
    const w = findRec(r, 'http_request.personal_data_outbound');
    assert.ok(w, `expected http_request.personal_data_outbound, got ${JSON.stringify(codesOf(r))}`);
    assert.equal(w.severity, 'warning');
    assert.match(w.message, /sends `customer_name` out of the workspace/);
    assert.ok(w.path.includes('t1'), `the canvas maps by step id, path was ${w.path}`);
    assert.match(w.path, /\.body$/, 'the path names the field the reference was found in');
});

test('camelCase and snake_case both count — the two spellings an automation actually uses', () => {
    for (const field of ['customerName', 'customer_name', 'phoneNumber', 'emailAddress']) {
        const r = validateDefinition(def([post('t1', `x {{trigger.output.${field}}}`)]));
        assert.ok(codesOf(r).includes('http_request.personal_data_outbound'),
            `${field} should read as personal, got ${JSON.stringify(codesOf(r))}`);
    }
});

test('a field that is not about a person is left alone', () => {
    for (const field of ['invoice_date', 'total', 'orderId', 'status']) {
        const r = validateDefinition(def([post('t1', `x {{trigger.output.${field}}}`)]));
        assert.ok(!codesOf(r).includes('http_request.personal_data_outbound'),
            `${field} must not read as personal, got ${JSON.stringify(codesOf(r))}`);
    }
    // Control: the same step, the same shape, one personal field.
    const control = validateDefinition(def([post('t1', 'x {{trigger.output.email}}')]));
    assert.ok(codesOf(control).includes('http_request.personal_data_outbound'), JSON.stringify(codesOf(control)));
});

test('a mail send is outbound; a mail SEARCH is not — the tool decides, not the step type', () => {
    const sends = validateDefinition(def([mail('m1', { to: ref('trigger.output.email'), body: ref('trigger.output.name') })]));
    assert.ok(codesOf(sends).includes('integration_action.personal_data_outbound'),
        `gmail_compose sends, got ${JSON.stringify(codesOf(sends))}`);

    const reads = validateDefinition(def([
        { id: 'm1', type: 'integration_action', tool: 'gmail_search', inputs: { query: ref('trigger.output.email') } },
    ]));
    assert.ok(!codesOf(reads).includes('integration_action.personal_data_outbound'),
        `gmail_search only reads, got ${JSON.stringify(codesOf(reads))}`);
});

test('an integration_action with no tool picked yet says nothing — it sends nothing yet', () => {
    const inputs = { body: ref('trigger.output.email') };
    const r = validateDefinition(def([{ id: 'm1', type: 'integration_action', inputs }]));
    assert.ok(!codesOf(r).includes('integration_action.personal_data_outbound'), JSON.stringify(codesOf(r)));
    // Control: the same inputs, once a sending tool is chosen.
    const control = validateDefinition(def([mail('m1', inputs)]));
    assert.ok(codesOf(control).includes('integration_action.personal_data_outbound'), JSON.stringify(codesOf(control)));
});

test('binding the WHOLE answer of an extraction step counts — the step declares what it pulls out', () => {
    const r = validateDefinition(def([
        extract('ext', [{ name: 'customer_name', type: 'string' }, { name: 'invoice_total', type: 'number' }], 'trigger.output.text'),
        post('t1', 'Alles: {{steps.ext.output}}'),
    ]));
    const w = findRec(r, 'http_request.personal_data_outbound');
    assert.ok(w, `expected the whole-output case to be caught, got ${JSON.stringify(codesOf(r))}`);
    assert.match(w.message, /`customer_name`/);
    assert.ok(!/invoice_total/.test(w.message), 'only the personal fields are named');
});

test('binding ONE harmless field of that step does not drag its other fields in', () => {
    const fields = [{ name: 'customer_name', type: 'string' }, { name: 'invoice_total', type: 'number' }];
    const r = validateDefinition(def([
        extract('ext', fields, 'trigger.output.text'),
        post('t1', 'Bedrag: {{steps.ext.output.invoice_total}}'),
    ]));
    assert.ok(!codesOf(r).includes('http_request.personal_data_outbound'),
        `only invoice_total is sent, got ${JSON.stringify(codesOf(r))}`);
    // Control: the same two-field extraction, with the personal one bound.
    const control = validateDefinition(def([
        extract('ext', fields, 'trigger.output.text'),
        post('t1', 'Naam: {{steps.ext.output.customer_name}}'),
    ]));
    assert.ok(codesOf(control).includes('http_request.personal_data_outbound'), JSON.stringify(codesOf(control)));
});

test('a datatable read the definition filters on by e-mail carries that column outbound', () => {
    const r = validateDefinition(def([
        { id: 'dt', type: 'datatable', datatableId: 'tbl_1', op: 'find_rows', where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'x' } }] },
        post('t1', 'Rijen: {{steps.dt.output.rows}}'),
    ]));
    const w = findRec(r, 'http_request.personal_data_outbound');
    assert.ok(w, `expected the datatable column to be evidence, got ${JSON.stringify(codesOf(r))}`);
    assert.match(w.message, /`email`/);
});

test('a code step is outbound too — its sandbox is handed a fetch', () => {
    const r = validateDefinition(def([
        { id: 'c1', type: 'code', code: 'return {}', inputs: { who: ref('trigger.output.email') } },
    ]));
    assert.ok(codesOf(r).includes('code.personal_data_outbound'), JSON.stringify(codesOf(r)));
});

test('the exit list is the shared one — a notification counts, because its e-mail channel leaves', () => {
    // Which step types leave the building is core/privacy/dataFlow's answer,
    // not this rule's. `notification` is in it (one of its channels mails a
    // workspace user), so it is in here too: a validator that quietly disagreed
    // with the compliance review about what "outbound" means is the second
    // answer this codebase keeps deleting.
    const r = validateDefinition(def([
        { id: 'n1', type: 'notification', title: 'Nieuwe lead', body: '{{trigger.output.customer_name}}', channels: ['email'] },
    ]));
    assert.ok(codesOf(r).includes('notification.personal_data_outbound'), JSON.stringify(codesOf(r)));
});

test('the message names the destination — Art. 30(1)(d) asks who received it', () => {
    const r = validateDefinition(def([mail('m1', { to: ref('trigger.output.email') })]));
    const w = findRec(r, 'integration_action.personal_data_outbound');
    assert.ok(w, JSON.stringify(codesOf(r)));
    assert.match(w.message, /out of the workspace, to gmail\.$/);
});

// ── 2. A model reading personal data with no Privacy Shield ─────────────────

test('an ai_step reading a personal field with no shield in the automation is warned about', () => {
    const r = validateDefinition(def([
        { id: 'a1', type: 'ai_step', prompt: 'Vat samen: {{steps.dt.output.email}}' },
    ]));
    const w = findRec(r, 'ai_step.personal_data_unguarded');
    assert.ok(w, `expected ai_step.personal_data_unguarded, got ${JSON.stringify(codesOf(r))}`);
    assert.equal(w.severity, 'warning');
    assert.match(w.message, /hands `email` to a model/);
    assert.match(w.message, /no Privacy Shield in front of it/);
    assert.ok(w.path.includes('a1'), `path was ${w.path}`);
});

test('a data_extraction pulling out a personal field is the same finding, from its own fields', () => {
    const r = validateDefinition(def([extract('ext', [{ name: 'bsn', type: 'string' }], 'trigger.output.text')]));
    const w = findRec(r, 'data_extraction.personal_data_unguarded');
    assert.ok(w, `expected data_extraction.personal_data_unguarded, got ${JSON.stringify(codesOf(r))}`);
    assert.match(w.message, /`bsn`/);
});

test('an ai_step downstream of a datatable read that names a personal column is caught', () => {
    const r = validateDefinition(def([
        { id: 'dt', type: 'datatable', datatableId: 'tbl_1', op: 'find_rows', where: [{ field: 'bsn', op: 'eq', value: { kind: 'literal', value: 'x' } }] },
        { id: 'a1', type: 'ai_step', prompt: 'Beoordeel: {{steps.dt.output.rows}}', outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } } },
    ]));
    assert.ok(codesOf(r).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(r)));
});

// The step every silencing test is about, and the bare automation that proves it
// speaks without one. Each case below adds exactly one step to `bare` — so a
// case that stops failing means the added step silenced it, not that the rule
// went missing.
const readsPersonal = (id = 'a1') => ({ id, type: 'ai_step', prompt: 'Vat samen: {{steps.dt.output.email}}' });
const bare = () => def([readsPersonal()]);

for (const [what, shield] of [
    ['a tokenize step — that is the fix the review proposes', { id: 't1', type: 'tokenize', sourceRef: 'trigger.output.body' }],
    ['a PLAIN guard: it branches, so there is somewhere to route the data', { id: 'g1', type: 'guard', sourceRef: 'trigger.output.body' }],
    ['a shield inside a loop body — the walk descends', { id: 'lp', type: 'loop', itemVar: 'it', overRef: 'trigger.output.items', body: [{ id: 'g1', type: 'guard', sourceRef: 'loop.it.output.body' }] }],
    ['a called Step, which may carry the shield where this rule cannot look', { id: 'cb', type: 'call_block', blockId: 'blk_1' }],
]) {
    test(`${what} silences the unguarded warning`, () => {
        const control = validateDefinition(bare());
        assert.ok(codesOf(control).includes('ai_step.personal_data_unguarded'),
            `control: without the shield it must warn, got ${JSON.stringify(codesOf(control))}`);
        const r = validateDefinition(def([shield, readsPersonal()]));
        assert.ok(!codesOf(r).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(r)));
    });
}

test('a shield AFTER the model does not silence it — a shield is a position, not a property', () => {
    const shield = { id: 't1', type: 'tokenize', sourceRef: 'trigger.output.body' };
    const before = validateDefinition(def([shield, readsPersonal()]));
    assert.ok(!codesOf(before).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(before)));
    // The same two steps, the other way round: the model has already read the
    // raw values by the time anything hides them. "Any shield anywhere" is how
    // an automation could silence this by dragging the node to the end.
    const after = validateDefinition(def([readsPersonal(), shield]));
    assert.ok(codesOf(after).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(after)));
});

test('an untokenize does NOT count — a reveal puts the real values back', () => {
    const r = validateDefinition(def([
        { id: 'u1', type: 'untokenize', sourceRef: 'trigger.output.text' },
        readsPersonal(),
    ]));
    assert.ok(codesOf(r).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(r)));
});

test('a summarize step is not an AI step — it is a sum, and never gets this warning', () => {
    const r = validateDefinition(def([
        { id: 's1', type: 'summarize', arrayRef: 'trigger.output.rows', op: 'count', field: 'email' },
    ]));
    assert.ok(!codesOf(r).some(c => c.endsWith('.personal_data_unguarded')), JSON.stringify(codesOf(r)));
    // Control: the same personal field, read by something that IS a model.
    const control = validateDefinition(bare());
    assert.ok(codesOf(control).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(control)));
});

test('a loop item variable named after a person is not itself personal data', () => {
    const r = validateDefinition(def([
        {
            id: 'lp', type: 'loop', itemVar: 'customer', overRef: 'trigger.output.items',
            body: [{ id: 'a1', type: 'ai_step', prompt: 'Vat samen: {{loop.customer.output.total}}' }],
        },
    ]));
    assert.ok(!codesOf(r).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(r)));
    // Control: the same loop, reading a field of the item that IS personal.
    const control = validateDefinition(def([
        {
            id: 'lp', type: 'loop', itemVar: 'customer', overRef: 'trigger.output.items',
            body: [{ id: 'a1', type: 'ai_step', prompt: 'Vat samen: {{loop.customer.output.email}}' }],
        },
    ]));
    assert.ok(codesOf(control).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(control)));
});

// ── 3. Both are warnings, at every stage ────────────────────────────────────

test('neither finding blocks a save or an activation', () => {
    const r = validateDefinition(def([
        extract('ext', [{ name: 'email', type: 'string' }], 'trigger.output.text'),
        post('t1', '{{steps.ext.output.email}}'),
    ]));
    for (const code of ['data_extraction.personal_data_unguarded', 'http_request.personal_data_outbound']) {
        assert.ok(codesOf(r).includes(code), `expected ${code}, got ${JSON.stringify(codesOf(r))}`);
        assert.ok(!r.errors.some(e => e.code === code), `${code} must never be an error`);
        // Not a completeness code either: these do not mean "unfinished", so
        // they must not gate activation the way a half-filled field does.
        assert.ok(!COMPLETENESS_CODES.has(code), `${code} must not be a completeness code`);
    }
    // `activate` is validateDefinition's default and is what `r` above is, so
    // the other end of the ladder is the one still worth asserting: a draft
    // autosave mid-keystroke must carry the same two warnings and no error.
    const draft = validateDefinition(def([
        extract('ext', [{ name: 'email', type: 'string' }], 'trigger.output.text'),
        post('t1', '{{steps.ext.output.email}}'),
    ]), { stage: 'draft' });
    assert.equal(r.ok, true, `a warning must leave the definition valid: ${JSON.stringify(r.errors)}`);
    assert.equal(draft.errors.filter(e => /\.personal_data_(outbound|unguarded)$/.test(e.code)).length, 0);
    assert.equal(draft.warnings.filter(w => /\.personal_data_(outbound|unguarded)$/.test(w.code)).length, 2);
});

// ── 4. The vocabularies this rule borrows, pinned ───────────────────────────

test('a fourth Privacy Shield shape forces a decision here rather than being ignored', () => {
    // This rule NARROWS core/privacy/dataFlow's shield list by one shape.
    // A narrowing is only honest while it is deliberate: if a shape is added
    // there and nobody looks here, it silently stops counting as protection
    // and every automation using it starts getting a warning it has already
    // answered. Take it or reject it in SHIELD_TYPES — do not delete this.
    const unaccounted = [...dataFlow.SHIELD_TYPES].filter(t => !SHIELD_TYPES.has(t) && t !== 'untokenize');
    assert.deepEqual(unaccounted, [],
        'core/privacy/dataFlow knows a Privacy Shield shape this rule neither counts nor deliberately drops');
    assert.ok(dataFlow.SHIELD_TYPES.has('untokenize'), 'the one shape dropped on purpose must still be a shape');
});

test('"a model reads this" is automationGraph\'s answer, and it never includes summarize', () => {
    // dataFlow.MODEL_TYPES carries `summarize` forward from the playbook
    // review's old hand-rolled list; execSummarize is sum/count/avg and never
    // calls a model, so a warning about "handing data to a model" on it would
    // be wrong. Whatever that list does, this one must stay the runtime's.
    assert.ok(!AI_STEP_TYPES.includes('summarize'));
    // `ai_tool` is in that list but is not a step type a definition can carry
    // (it is the runner's in-agent tool call), so only the two that are
    // authorable are exercised here — VALID_STEP_TYPES is what says which.
    const authorable = AI_STEP_TYPES.filter(t => VALID_STEP_TYPES.has(t));
    assert.deepEqual(authorable, ['ai_step', 'data_extraction']);
    for (const type of authorable) {
        const r = validateDefinition(def([{ id: 'a1', type, prompt: 'x {{trigger.output.email}}', source: ref('trigger.output.email'), fields: [{ name: 'email', type: 'string' }] }]));
        assert.ok(codesOf(r).includes(`${type}.personal_data_unguarded`),
            `${type} is a model step, got ${JSON.stringify(codesOf(r))}`);
    }
    // And the step the two lists disagree about stays silent.
    const summarize = validateDefinition(def([{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.rows', op: 'count', field: 'email' }]));
    assert.ok(!codesOf(summarize).some(c => c.endsWith('.personal_data_unguarded')), JSON.stringify(codesOf(summarize)));
});

test('an automation that touches no personal data gets neither warning', () => {
    const schema = (props) => ({ type: 'object', properties: props });
    const r = validateDefinition(def([
        { id: 'a1', type: 'ai_step', prompt: 'Schrijf een samenvatting van {{trigger.output.invoice_total}}', outputSchema: schema({ summary: { type: 'string' } }) },
        post('t1', '{{steps.a1.output.summary}}'),
    ]));
    assert.ok(!codesOf(r).some(c => c.endsWith('.personal_data_outbound') || c.endsWith('.personal_data_unguarded')),
        JSON.stringify(codesOf(r)));
    // Control: the same two steps, with the model asked to produce a name —
    // an output SCHEMA is evidence too, whatever the prompt reads from.
    const control = validateDefinition(def([
        { id: 'a1', type: 'ai_step', prompt: 'Schrijf een samenvatting van {{trigger.output.invoice_total}}', outputSchema: schema({ customer_name: { type: 'string' } }) },
        post('t1', '{{steps.a1.output.customer_name}}'),
    ]));
    assert.ok(codesOf(control).includes('ai_step.personal_data_unguarded'), JSON.stringify(codesOf(control)));
    assert.ok(codesOf(control).includes('http_request.personal_data_outbound'), JSON.stringify(codesOf(control)));
});

// ── Paths are read with the runner's grammar ───────────────────────────────

test('a personal field behind a bracketed key is seen like a dotted one', () => {
    // The old dotted-identifier scan stopped at `[`, so a key the picker has to
    // bracket (a hyphen, a space) was invisible to this rule.
    for (const body of ['x {{trigger.output["e-mail"]}}', 'x {{ trigger.output.contact["customer name"] }}', 'x {{trigger.output.people[0].phone-number}}']) {
        const r = validateDefinition(def([post('t1', body)]));
        assert.ok(codesOf(r).includes('http_request.personal_data_outbound'), `${body}: ${JSON.stringify(codesOf(r))}`);
    }
    // Control: a member CALLED trigger is not a root.
    const member = validateDefinition(def([post('t1', 'x {{vars.trigger.output.total}}')]));
    assert.ok(!codesOf(member).includes('http_request.personal_data_outbound'), JSON.stringify(codesOf(member)));
});

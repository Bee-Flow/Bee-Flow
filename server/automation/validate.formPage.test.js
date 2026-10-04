const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const codesOf = (res) => (res.errors || []).concat(res.warnings || []).map(r => r.code);
const formCodes = (res) => codesOf(res).filter(c => c.startsWith('form_page.') || c.startsWith('layer.form_page'));

const FORM_TRIGGER = {
    id: 'trg', type: 'trigger', kind: 'form',
    form: { title: 'Start', fields: [{ name: 'name', type: 'text', label: 'Name', required: true }] },
};

const inputPage = (extra = {}) => ({
    id: 'fp1', type: 'form_page', mode: 'input',
    form: { title: 'More', fields: [{ name: 'address', type: 'text', label: 'Address' }] },
    ...extra,
});

/** trigger → fp1 → tail notification. */
function definition(steps, { trigger = FORM_TRIGGER, edges = null } = {}) {
    const tail = { id: 'end', type: 'notification', channel: 'email', to: 'a@b.nl', subject: 'hi', body: 'hi' };
    const all = [...steps, tail];
    const chain = [{ from: trigger.id, to: all[0].id }];
    for (let i = 0; i < all.length - 1; i++) chain.push({ from: all[i].id, to: all[i + 1].id });
    return { trigger, steps: all, edges: edges || chain };
}

test('a complete form page validates clean', () => {
    assert.deepEqual(formCodes(validateDefinition(definition([inputPage()]))), []);
});

test('a form page needs the automation to start with a form trigger', () => {
    // It is served on the trigger's public URL; without one it can never show.
    const res = validateDefinition(definition([inputPage()], {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    }));
    assert.ok(codesOf(res).includes('form_page.no_form_trigger'));
    assert.equal(res.ok, false);
    // …and it is a hard error, not a completeness nag: no amount of filling in
    // the page makes a manual-triggered automation able to show it.
    assert.equal(COMPLETENESS_CODES.has('form_page.no_form_trigger'), false);
});

test('an unfinished page is draft-saveable but blocks activation', () => {
    assert.ok(COMPLETENESS_CODES.has('form_page.incomplete'));
    const bare = definition([{ id: 'fp1', type: 'form_page', mode: 'input' }]);

    const draft = validateDefinition(bare, { stage: 'draft' });
    const warned = (draft.warnings || []).find(r => r.code === 'form_page.incomplete');
    assert.ok(warned, 'reported at draft stage');
    assert.equal(warned.blockedAt, 'activate');

    const activate = validateDefinition(bare);
    assert.ok((activate.errors || []).some(r => r.code === 'form_page.incomplete'));
    assert.equal(activate.ok, false);
});

test('an ending page is complete with no fields at all', () => {
    const res = validateDefinition(definition([{
        id: 'bye', type: 'form_page', mode: 'ending',
        form: { title: 'All done', description: 'We handled {{trigger.output.name}}.' },
    }]));
    assert.deepEqual(formCodes(res), []);
});

test('the same page as an input page IS incomplete — nothing to submit', () => {
    const res = validateDefinition(definition([{
        id: 'ask', type: 'form_page', mode: 'input',
        form: { title: 'All done', description: 'text only' },
    }]));
    assert.ok(codesOf(res).includes('form_page.incomplete'));
});

test('field-level problems surface with a path that points at the step', () => {
    const res = validateDefinition(definition([inputPage({
        form: {
            title: 'More',
            fields: [
                { name: 'address', type: 'text' },
                { name: 'address', type: 'text' },      // duplicate
                { name: '2bad', type: 'text' },         // not an identifier
                { name: 'pick', type: 'select', options: [] },
            ],
        },
    })]));
    const codes = codesOf(res);
    assert.ok(codes.includes('form_page.field_name_duplicate'));
    assert.ok(codes.includes('form_page.field_name'));
    assert.ok(codes.includes('form_page.field_options'));
    const dup = res.errors.find(r => r.code === 'form_page.field_name_duplicate');
    assert.match(dup.path, /steps\[fp1\]\.form\.fields\[1\]\.name/);
});

test('mode and waitSeconds are range-checked', () => {
    assert.ok(codesOf(validateDefinition(definition([inputPage({ mode: 'sideways' })]))).includes('form_page.mode'));
    assert.ok(codesOf(validateDefinition(definition([inputPage({ waitSeconds: 5 })]))).includes('form_page.wait_range'));
    assert.ok(codesOf(validateDefinition(definition([inputPage({ waitSeconds: 99 * 24 * 3600 })]))).includes('form_page.wait_range'));
    // The supported range and the absent case are both fine.
    assert.deepEqual(formCodes(validateDefinition(definition([inputPage({ waitSeconds: 900 })]))), []);
    assert.deepEqual(formCodes(validateDefinition(definition([inputPage({ waitSeconds: 7 * 24 * 3600 })]))), []);
});

test('an error branch off a form page is refused — a pause is not a failure', () => {
    const def = definition([inputPage()]);
    def.edges.push({ from: 'fp1', to: 'end', label: 'on_error' });
    assert.ok(codesOf(validateDefinition(def)).some(c => c.startsWith('edge.')), 'the on_error edge is rejected');
});

test('a question asked after the closing page is a warning', () => {
    const res = validateDefinition(definition([
        { id: 'bye', type: 'form_page', mode: 'ending', form: { title: 'Thanks' } },
        inputPage(),
    ]));
    const w = (res.warnings || []).find(r => r.code === 'form_page.input_after_ending');
    assert.ok(w, 'warned about the ordering');
    assert.equal(res.ok, true, 'but it still saves — it is a wiring smell, not a broken flow');
});

test('the reverse order (question, then closing page) is clean', () => {
    const res = validateDefinition(definition([
        inputPage(),
        { id: 'bye', type: 'form_page', mode: 'ending', form: { title: 'Thanks' } },
    ]));
    assert.deepEqual(formCodes(res), []);
});

test('a form page inside a loop or a parallel branch is refused', () => {
    // Same reason as the layer case: resume replays the PARENT graph by step
    // id, and sub-step rows carry a parent_step_id the replay skips. The
    // runner would pause here and then never be able to continue.
    const loop = validateDefinition(definition([{
        id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item',
        body: [inputPage()],
    }]));
    assert.ok(codesOf(loop).includes('form_page.nested_forbidden'), JSON.stringify(codesOf(loop)));
    assert.equal(loop.ok, false);

    const par = validateDefinition(definition([{
        id: 'par', type: 'parallel', branches: [[inputPage()]],
    }]));
    assert.ok(codesOf(par).includes('form_page.nested_forbidden'));
});

test('a form page inside a layer is refused — a pause there has no resumable address', () => {
    const res = validateDefinition({
        trigger: FORM_TRIGGER,
        steps: [
            { id: 'cl1', type: 'call_layer', layerKey: 'sub' },
            { id: 'end', type: 'notification', channel: 'email', to: 'a@b.nl', subject: 'x', body: 'y' },
        ],
        edges: [{ from: 'trg', to: 'cl1' }, { from: 'cl1', to: 'end' }],
        layers: {
            sub: {
                title: 'Sub',
                trigger: { id: 'li', type: 'trigger', kind: 'layer_input' },
                steps: [
                    inputPage(),
                    { id: 'lo', type: 'layer_output', fields: {} },
                ],
                edges: [{ from: 'li', to: 'fp1' }, { from: 'fp1', to: 'lo' }],
            },
        },
    });
    assert.ok(codesOf(res).includes('layer.form_page_forbidden'));
    assert.equal(res.ok, false);
});

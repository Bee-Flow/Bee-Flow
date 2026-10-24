// @typecheck
'use strict';

/**
 * automation/formDraft — the clamps between a model's answer and a form.
 *
 * What a person would be hurt by if it slipped:
 *   - in REVISE mode a kept question keeps its NAME — the name is the column
 *     in the answers table; a model that returns a new name for an old
 *     question must not be able to retire a column full of answers;
 *   - a name the model invents is never trusted: it is derived from the
 *     label, and in create mode always;
 *   - display types (download/notebook) and unknown types become text; a
 *     select without choices becomes text; more than MAX_FIELDS is cut and
 *     said in `notes`;
 *   - the theme and `collect` — which the model never sees — survive;
 *   - the brief and the current form are fenced as quoted material.
 *
 * Run: cd server && node --test --test-force-exit automation/formDraft.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildDraftMessages, parseFormDraft, nameFromLabel, describeCurrent, DRAFT_TOOL, INPUT_TYPES, MAX_BRIEF_CHARS } = require('./formDraft');
const { MAX_FIELDS } = require('./formTriggerContract');

const CURRENT = {
    title: 'Customer feedback', description: 'Tell us', submitLabel: 'Send', successMessage: 'Thanks!', collect: true,
    theme: { radius: 'lg' },
    fields: [
        { name: 'email', type: 'email', label: 'Your e-mail', required: true },
        { name: 'source', type: 'select', label: 'How did you hear about us?', options: ['search', 'colleague'] },
        { name: 'more', type: 'textarea', label: 'Anything else?' },
    ],
};

test('the tool offers only the input types — never download or notebook', () => {
    assert.ok(INPUT_TYPES.includes('text') && INPUT_TYPES.includes('file'));
    assert.ok(!INPUT_TYPES.includes('download') && !INPUT_TYPES.includes('notebook'));
    assert.deepStrictEqual(DRAFT_TOOL.function.parameters.properties.fields.items.properties.type.enum, INPUT_TYPES);
});

test('create: names come from labels, never from the model; select without choices is text; unknown types are text', () => {
    const out = parseFormDraft({
        title: 'Vacation request',
        fields: [
            { name: 'hax0r', label: 'Your name', type: 'text', required: true },
            { label: 'Your name', type: 'text' },
            { label: 'Department', type: 'select', options: [] },
            { label: 'Team', type: 'select', options: ['Sales', 'Sales', { label: 'Support' }] },
            { label: 'Attach the plan', type: 'download' },
            { label: 'Reason', type: 'whatever' },
            { label: '   ', type: 'text' },
        ],
    }, { mode: 'create', current: CURRENT });
    assert.ok(out);
    assert.deepStrictEqual(out.form.fields.map(f => f.name), ['your_name', 'your_name_2', 'department', 'team', 'attach_the_plan', 'reason']);
    assert.strictEqual(out.form.fields[2].type, 'text');
    assert.deepStrictEqual(out.form.fields[3].options, ['Sales', 'Support']);
    assert.strictEqual(out.form.fields[4].type, 'text');
    assert.strictEqual(out.form.fields[5].type, 'text');
    assert.strictEqual(out.form.fields[0].required, true);
    assert.strictEqual(out.form.fields[1].required, false);
    // the parts the model never sees are carried over
    assert.deepStrictEqual(out.form.theme, { radius: 'lg' });
    assert.strictEqual(out.form.collect, true);
    assert.strictEqual(out.form.title, 'Vacation request');
    // create mode: the intro is the model's (empty here), not the old one
    assert.strictEqual(out.form.description, '');
});

test('revise: a returned name is kept ONLY when the form already has it; everything else is named from its label', () => {
    const out = parseFormDraft({
        title: 'Customer feedback',
        fields: [
            { name: 'email', label: 'Your e-mail address', type: 'email', required: true },
            { name: 'source_v2', label: 'How did you hear about us?', type: 'select', options: ['search', 'colleague', 'event'] },
            { name: 'more', label: 'Anything else?', type: 'textarea' },
            { label: 'Phone number', type: 'text' },
        ],
    }, { mode: 'revise', current: CURRENT });
    assert.ok(out);
    assert.deepStrictEqual(out.form.fields.map(f => f.name), ['email', 'how_did_you_hear_about_us', 'more', 'phone_number']);
    // relabel kept the identity
    assert.strictEqual(out.form.fields[0].label, 'Your e-mail address');
    // revise mode keeps the intro the model left out
    assert.strictEqual(out.form.description, 'Tell us');
    assert.strictEqual(out.form.submitLabel, 'Send');
});

test('revise: the same existing name twice is not two questions', () => {
    const out = parseFormDraft({
        fields: [
            { name: 'email', label: 'E-mail', type: 'email' },
            { name: 'email', label: 'E-mail again', type: 'email' },
        ],
    }, { mode: 'revise', current: CURRENT });
    assert.deepStrictEqual(out.form.fields.map(f => f.name), ['email', 'e_mail_again']);
});

test('more than MAX_FIELDS is cut, and the note says so', () => {
    const fields = Array.from({ length: MAX_FIELDS + 3 }, (_, i) => ({ label: `Question ${i + 1}`, type: 'text' }));
    const out = parseFormDraft({ title: 'Long', fields, notes: 'Grouped the address.' }, { mode: 'create' });
    assert.strictEqual(out.form.fields.length, MAX_FIELDS);
    assert.match(out.notes, /Grouped the address\./);
    assert.match(out.notes, /3 more questions left out/);
});

test('nothing usable → null', () => {
    assert.strictEqual(parseFormDraft(null), null);
    assert.strictEqual(parseFormDraft({ title: 'x' }), null);
    assert.strictEqual(parseFormDraft({ fields: [{ type: 'text' }] }), null);
    assert.strictEqual(parseFormDraft({ fields: 'nope' }), null);
});

test('defaults fill what the model left out', () => {
    const out = parseFormDraft({ fields: [{ label: 'Name', type: 'text' }] }, { mode: 'create' });
    assert.strictEqual(out.form.title, 'Untitled form');
    assert.strictEqual(out.form.submitLabel, 'Submit');
    assert.ok(out.form.successMessage.length > 0);
    assert.strictEqual(out.notes, null);
});

test('nameFromLabel is the builder\'s slug, unique, and always a valid parameter name', () => {
    const taken = new Set();
    assert.strictEqual(nameFromLabel('Your e-mail?', taken), 'your_e_mail');
    taken.add('your_e_mail');
    assert.strictEqual(nameFromLabel('Your e-mail?', taken), 'your_e_mail_2');
    assert.strictEqual(nameFromLabel('123', taken), 'question');
    // NFKD then strip marks — the builder's own rule, kept identical on purpose
    assert.match(nameFromLabel('Ärger über Café', taken), /^[a-z][a-z0-9_]*$/);
});

test('create messages fence the brief; revise messages quote the current names and the request', () => {
    const create = buildDraftMessages({ mode: 'create', brief: 'An intake form for new clients.\r\nAsk the company name.', note: 'Dutch please' });
    assert.strictEqual(create.length, 2);
    assert.match(create[1].content, /<brief>\nAn intake form for new clients\.\nAsk the company name\.\n<\/brief>/);
    assert.match(create[1].content, /<also>\nDutch please\n<\/also>/);
    assert.match(create[0].content, /draft_form/);

    const revise = buildDraftMessages({ mode: 'revise', note: 'add a phone number', current: CURRENT });
    assert.match(revise[0].content, /CHANGING a form/);
    assert.match(revise[0].content, /QUOTED MATERIAL/);
    assert.match(revise[1].content, /\[name: email\] Your e-mail \(email, required\)/);
    assert.match(revise[1].content, /choices: search \| colleague/);
    assert.match(revise[1].content, /<request>\nadd a phone number\n<\/request>/);
    assert.match(revise[1].content, /Title: Customer feedback/);
});

test('a brief longer than the cap is cut, not refused', () => {
    const long = 'x'.repeat(MAX_BRIEF_CHARS + 500);
    const msgs = buildDraftMessages({ mode: 'create', brief: long });
    assert.ok(msgs[1].content.length < MAX_BRIEF_CHARS + 400);
});

test('the tool offers radio and multiselect, and never the text block', () => {
    assert.ok(INPUT_TYPES.includes('radio') && INPUT_TYPES.includes('multiselect'));
    assert.ok(!INPUT_TYPES.includes('info'));
});

test('radio and multiselect keep their options; a choice without options becomes text', () => {
    const out = parseFormDraft({
        title: 'Intake',
        fields: [
            { label: 'Size', type: 'radio', options: ['Small', 'Large', 'Small'] },
            { label: 'Topics', type: 'multiselect', options: [{ label: 'Billing' }, 'Support'] },
            { label: 'Colour', type: 'radio', options: [] },
            { label: 'Extras', type: 'multiselect' },
            { label: 'About', type: 'info' },
        ],
    }, { mode: 'create', current: CURRENT });
    assert.ok(out);
    assert.deepStrictEqual(out.form.fields.map(f => f.type), ['radio', 'multiselect', 'text', 'text', 'text']);
    assert.deepStrictEqual(out.form.fields[0].options, ['Small', 'Large']);
    assert.deepStrictEqual(out.form.fields[1].options, ['Billing', 'Support']);
    assert.strictEqual('options' in out.form.fields[2], false);
});

test('the current choices of a radio or multiselect are quoted to the model on revise', () => {
    const text = describeCurrent({ fields: [
        { name: 'size', type: 'radio', label: 'Size', options: ['Small', 'Large'] },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['A', 'B'] },
    ] });
    assert.match(text, /choices: Small \| Large/);
    assert.match(text, /choices: A \| B/);
});

// ── revise keeps what the model is not taught ──────────────────────────────

const WIZARD = {
    title: 'Request', submitLabel: 'Send', successMessage: 'Thanks', collect: true,
    fields: [
        { name: 'contact', type: 'radio', label: 'How should we reach you?', required: true, options: [{ value: 'email', label: 'By e-mail', hint: 'Fastest' }, 'phone'] },
        { name: 'intro', type: 'info', label: 'Note', content: 'We answer within two days.' },
        { name: 'address', type: 'email', label: 'Your e-mail', showIf: 'form.contact == "email"', maxLength: 80 },
        { name: 'amount', type: 'number', label: 'Amount', min: 1, max: 500 },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['a', 'b', 'c'], minSelected: 1, maxSelected: 2 },
    ],
};

const reviseReply = (fields) => ({ fields });

test('revise: showIf, value rules and the stored choice values survive a pass through the model', () => {
    const out = parseFormDraft(reviseReply([
        { name: 'contact', label: 'How should we reach you?', type: 'radio', required: true, options: ['By e-mail', 'phone'] },
        { name: 'address', label: 'E-mail address', type: 'email' },
        { name: 'amount', label: 'Amount', type: 'number' },
        { name: 'topics', label: 'Topics', type: 'multiselect', options: ['a', 'b', 'c'] },
    ]), { mode: 'revise', current: WIZARD });
    assert.ok(out);
    const by = (n) => out.form.fields.find(f => f.name === n);
    assert.strictEqual(by('address').showIf, 'form.contact == "email"');
    assert.strictEqual(by('address').maxLength, 80);
    assert.strictEqual(by('address').label, 'E-mail address', 'what the model changed is applied');
    assert.deepStrictEqual([by('amount').min, by('amount').max], [1, 500]);
    assert.deepStrictEqual([by('topics').minSelected, by('topics').maxSelected], [1, 2]);
    assert.deepStrictEqual(by('contact').options, [{ value: 'email', label: 'By e-mail', hint: 'Fastest' }, 'phone'], 'the stored value and hint stay');
});

test('revise: a text block is not shown to the model and goes back where it was', () => {
    assert.ok(!describeCurrent(WIZARD).includes('intro'));
    const out = parseFormDraft(reviseReply([
        { name: 'contact', label: 'How should we reach you?', type: 'radio', options: ['phone'] },
        { name: 'address', label: 'Your e-mail', type: 'email' },
    ]), { mode: 'revise', current: WIZARD });
    assert.deepStrictEqual(out.form.fields.map(f => f.name), ['contact', 'intro', 'address']);
    assert.deepStrictEqual(out.form.fields[1], WIZARD.fields[1]);
});

test('revise: a block whose neighbour was removed lands after the nearest earlier question that is left; a new question never takes its name', () => {
    const out = parseFormDraft(reviseReply([
        { label: 'Note', type: 'text' },
        { name: 'address', label: 'Your e-mail', type: 'email' },
    ]), { mode: 'revise', current: WIZARD });
    // `contact` is gone: the block has no earlier question and moves to the front.
    assert.deepStrictEqual(out.form.fields.map(f => f.name), ['intro', 'note', 'address']);
    assert.strictEqual(out.form.fields[0].type, 'info');
    assert.strictEqual(out.form.fields[1].type, 'text');
});

test('revise: a changed type keeps the condition and only the rules the new type accepts', () => {
    const out = parseFormDraft(reviseReply([
        { name: 'contact', label: 'How should we reach you?', type: 'radio', options: ['phone', 'By e-mail'] },
        { name: 'address', label: 'Your e-mail', type: 'text' },
        { name: 'amount', label: 'Amount', type: 'date' },
    ]), { mode: 'revise', current: WIZARD });
    const by = (n) => out.form.fields.find(f => f.name === n);
    assert.strictEqual(by('address').showIf, 'form.contact == "email"');
    assert.strictEqual(by('address').maxLength, 80, 'maxLength is a rule of text too');
    assert.ok(!('min' in by('amount')) && !('max' in by('amount')), 'number bounds do not travel to a date');
});

test('revise: a condition on a question the model removed is dropped instead of losing the draft', () => {
    const out = parseFormDraft(reviseReply([
        { name: 'address', label: 'Your e-mail', type: 'email' },
    ]), { mode: 'revise', current: WIZARD });
    assert.ok(out, 'the draft survives');
    const address = out.form.fields.find(f => f.name === 'address');
    assert.ok(!('showIf' in address));
    assert.ok(out.form.fields.some(f => f.type === 'info'), 'the text block is kept');
});

test('create mode ignores the current form entirely: no condition, no block', () => {
    const out = parseFormDraft(reviseReply([{ name: 'address', label: 'Your e-mail', type: 'email' }]), { mode: 'create', current: WIZARD });
    assert.deepStrictEqual(out.form.fields.map(f => f.name), ['your_e_mail']);
});

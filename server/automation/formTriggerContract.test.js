const test = require('node:test');
const assert = require('node:assert');

const {
    FIELD_TYPES,
    MAX_UPLOAD_MB,
    isFormTriggerDefinition,
    formTriggerFields,
    validateFormTrigger,
    validateFormDeclaration,
    renderConfig,
    renderFormConfig,
    coerceSubmission,
    normalizeFields,
    emptyFormValues,
} = require('./formTriggerContract');

const def = (form) => ({ trigger: { id: 'trg', type: 'trigger', kind: 'form', form } });
const codes = (issues) => issues.map(i => i.code);

const FORM = {
    title: 'Contact us',
    fields: [
        { name: 'email', type: 'email', label: 'Your email', required: true },
        { name: 'topic', type: 'select', label: 'Topic', options: ['Sales', 'Support'], required: true },
        { name: 'message', type: 'textarea', label: 'Message' },
        { name: 'consent', type: 'checkbox', label: 'I agree', required: true },
        { name: 'attachment', type: 'file', label: 'Attachment', accept: 'application/pdf', maxSizeMb: 5 },
    ],
};

test('isFormTriggerDefinition only matches the form kind', () => {
    assert.equal(isFormTriggerDefinition(def(FORM)), true);
    assert.equal(isFormTriggerDefinition({ trigger: { kind: 'webhook' } }), false);
    assert.equal(isFormTriggerDefinition(null), false);
});

test('formTriggerFields normalizes and drops the unusable', () => {
    const fields = formTriggerFields(def({
        fields: [
            { name: 'ok', type: 'text' },
            { name: '_leading', type: 'text' },     // reserved prefix
            { name: '2bad', type: 'text' },         // not an identifier
            { name: 'ok', type: 'text' },           // duplicate
            'nonsense',
            { name: 'weird', type: 'colour' },      // unknown type → text
        ],
    }));
    assert.deepEqual(fields.map(f => f.name), ['ok', 'weird']);
    assert.equal(fields[1].type, 'text');
    // label defaults to the name so a field is never anonymous on the page.
    assert.equal(fields[0].label, 'ok');
});

test('select options accept both plain strings and {value,label}', () => {
    const [f] = formTriggerFields(def({
        fields: [{ name: 'topic', type: 'select', options: ['Sales', { value: 'sup', label: 'Support' }, { nope: 1 }, ''] }],
    }));
    assert.deepEqual(f.options, [
        { value: 'Sales', label: 'Sales' },
        { value: 'sup', label: 'Support' },
    ]);
});

test('a file field clamps maxSizeMb to the platform ceiling', () => {
    const [big] = formTriggerFields(def({ fields: [{ name: 'f', type: 'file', maxSizeMb: 500 }] }));
    assert.equal(big.maxSizeMb, MAX_UPLOAD_MB);
    const [none] = formTriggerFields(def({ fields: [{ name: 'f', type: 'file' }] }));
    assert.equal(none.maxSizeMb, 10);
});

test('every declared type is reachable', () => {
    const fields = formTriggerFields(def({ fields: FIELD_TYPES.map((t, i) => ({ name: `f${i}`, type: t, options: ['a'] })) }));
    assert.deepEqual(fields.map(f => f.type), FIELD_TYPES);
});

// ── declaration validation ────────────────────────────

test('a complete form validates clean', () => {
    assert.deepEqual(validateFormTrigger(FORM), []);
});

test('a missing or empty form is a COMPLETENESS problem, not a shape error', () => {
    assert.deepEqual(codes(validateFormTrigger(undefined)), ['incomplete']);
    assert.deepEqual(codes(validateFormTrigger({ fields: [] })), ['incomplete']);
});

test('duplicate and malformed field names are reported per field', () => {
    const issues = validateFormTrigger({ fields: [{ name: 'a' }, { name: 'a' }, { name: '_x' }] });
    assert.ok(codes(issues).includes('field_name_duplicate'));
    assert.ok(codes(issues).includes('field_name'));
});

test('a dropdown with no choices is rejected — it can never be answered', () => {
    assert.ok(codes(validateFormTrigger({ fields: [{ name: 'topic', type: 'select', options: [] }] })).includes('field_options'));
});

test('theme values are validated against the shared spec', () => {
    assert.deepEqual(validateFormTrigger({ ...FORM, theme: { primary: '#0F766E', radius: 'lg' } }), []);
    const bad = validateFormTrigger({ ...FORM, theme: { primary: 'teal', radius: 'enormous', nope: 1 } });
    assert.deepEqual(codes(bad).sort(), ['theme_color', 'theme_enum', 'theme_unknown_key']);
});

test('an over-long field list is rejected', () => {
    const fields = Array.from({ length: 41 }, (_, i) => ({ name: `f${i}`, type: 'text' }));
    assert.ok(codes(validateFormTrigger({ fields })).includes('fields_too_many'));
});

// ── render config ─────────────────────────────────────

test('renderConfig fills every default and never leaks unknown keys', () => {
    const cfg = renderConfig(def({ fields: [{ name: 'a' }], secretNote: 'internal only' }));
    assert.equal(cfg.title, 'Form');
    assert.equal(cfg.submitLabel, 'Submit');
    assert.ok(cfg.successMessage.length > 0);
    assert.equal(cfg.theme.primary, '#0F766E');
    assert.equal(cfg.theme.appearance, 'auto');
    assert.equal('secretNote' in cfg, false);
    assert.equal(JSON.stringify(cfg).includes('internal only'), false);
});

test('renderConfig repairs an invalid theme rather than shipping a broken one', () => {
    const cfg = renderConfig(def({ fields: [{ name: 'a' }], theme: { primary: 'not-a-hex', radius: 'huge' } }));
    assert.equal(cfg.theme.primary, '#0F766E');
    assert.equal(cfg.theme.radius, 'md');
});

// ── submission coercion ───────────────────────────────

const FIELDS = formTriggerFields(def(FORM));

test('a good submission coerces to the declared shapes', () => {
    const { values, files, errors } = coerceSubmission(FIELDS, {
        email: ' a@b.nl ',
        topic: 'Sales',
        message: 'hi',
        consent: 'on',
        attachment: { kind: 'form_upload', fileId: 'up_1' },
    });
    assert.deepEqual(errors, []);
    assert.equal(values.email, 'a@b.nl');
    assert.equal(values.consent, true);
    assert.deepEqual(values.attachment, { kind: 'form_upload', fileId: 'up_1' });
    assert.deepEqual(files, [{ field: 'attachment', fileId: 'up_1' }]);
});

test('every missing required field is reported, one message each', () => {
    const { errors } = coerceSubmission(FIELDS, {});
    assert.deepEqual(errors.map(e => e.field).sort(), ['consent', 'email', 'topic']);
    assert.ok(errors[0].message.includes('required'));
});

test('an unchecked required checkbox is a missing answer, not a false one', () => {
    const { errors } = coerceSubmission(FIELDS, { email: 'a@b.nl', topic: 'Sales', consent: false });
    assert.deepEqual(errors.map(e => e.field), ['consent']);
});

test('an off-list dropdown value is rejected', () => {
    const { errors } = coerceSubmission(FIELDS, { email: 'a@b.nl', topic: 'Billing', consent: true });
    assert.deepEqual(errors.map(e => e.field), ['topic']);
});

test('a malformed email is rejected', () => {
    const { errors } = coerceSubmission(FIELDS, { email: 'nope', topic: 'Sales', consent: true });
    assert.equal(errors[0].field, 'email');
});

test('a file value that is not an upload descriptor is rejected', () => {
    const { errors } = coerceSubmission(FIELDS, {
        email: 'a@b.nl', topic: 'Sales', consent: true, attachment: { kind: 'studio_attachment', fileId: 'x' },
    });
    assert.deepEqual(errors.map(e => e.field), ['attachment']);
});

test('undeclared keys in the body never reach the values', () => {
    const { values } = coerceSubmission(FIELDS, { email: 'a@b.nl', topic: 'Sales', consent: true, admin: true, extra: 'x' });
    assert.equal('admin' in values, false);
    assert.equal('extra' in values, false);
    assert.deepEqual(Object.keys(values).sort(), ['attachment', 'consent', 'email', 'message', 'topic']);
});

test('__proto__ in the body cannot pollute anything', () => {
    // Parsed from JSON so the key is a real own property, the way express gives it to us.
    const body = JSON.parse('{"email":"a@b.nl","topic":"Sales","consent":true,"__proto__":{"polluted":"yes"}}');
    const { values } = coerceSubmission(FIELDS, body);
    assert.equal(Object.getPrototypeOf(values), null);
    assert.equal({}.polluted, undefined);
    assert.equal(values.polluted, undefined);
});

test('a polluted Object.prototype cannot supply a value for a field left blank', () => {
    Object.defineProperty(Object.prototype, 'message', { value: 'injected', configurable: true, enumerable: false });
    try {
        const { values } = coerceSubmission(FIELDS, { email: 'a@b.nl', topic: 'Sales', consent: true });
        assert.equal(values.message, '');
    } finally {
        delete Object.prototype.message;
    }
});

test('long text is capped rather than rejected', () => {
    const { values, errors } = coerceSubmission(FIELDS, {
        email: 'a@b.nl', topic: 'Sales', consent: true, message: 'x'.repeat(50_000),
    });
    assert.deepEqual(errors, []);
    assert.equal(values.message.length, 20_000);
});

// ── form_page reuse: templating, theme inheritance, ending pages ──────────
//
// A form_page step declares the SAME `form` object as the trigger, but its
// text is rendered against the paused run — that is how "show a summary of
// what the workflow did" works without a second contract.

/** Stand-in for the engine's interpolateTemplate. */
const interp = (map) => (s) => s.replace(/\{\{(.+?)\}\}/g, (_, k) => (k.trim() in map ? map[k.trim()] : ''));

test('renderFormConfig interpolates the human-readable text', () => {
    const cfg = renderFormConfig({
        title: 'Thanks {{name}}',
        description: 'Ticket {{ticket}} is open',
        submitLabel: 'Send {{name}}',
        successMessage: 'Bye {{name}}',
        fields: [{ name: 'note', type: 'text', label: 'Note for {{name}}', placeholder: 'Hi {{name}}', help: 'about {{ticket}}' }],
    }, { interpolate: interp({ name: 'Ada', ticket: 'T-9' }) });

    assert.equal(cfg.title, 'Thanks Ada');
    assert.equal(cfg.description, 'Ticket T-9 is open');
    assert.equal(cfg.submitLabel, 'Send Ada');
    assert.equal(cfg.successMessage, 'Bye Ada');
    assert.equal(cfg.fields[0].label, 'Note for Ada');
    assert.equal(cfg.fields[0].placeholder, 'Hi Ada');
    assert.equal(cfg.fields[0].help, 'about T-9');
});

test('option VALUES stay raw so the rendered choices match the accepted ones', () => {
    // Templating a value would make the page offer something coerceSubmission
    // then rejects as "not one of the offered choices".
    const cfg = renderFormConfig({
        fields: [{ name: 'pick', type: 'select', options: [{ value: 'a', label: 'Option for {{name}}' }] }],
    }, { interpolate: interp({ name: 'Ada' }) });
    assert.equal(cfg.fields[0].options[0].value, 'a');
    assert.equal(cfg.fields[0].options[0].label, 'Option for Ada');
});

test('a throwing interpolator falls back to the raw string instead of blanking the page', () => {
    const cfg = renderFormConfig({ title: 'Hi {{boom}}', fields: [] }, {
        interpolate: () => { throw new Error('bad template'); },
    });
    assert.equal(cfg.title, 'Hi {{boom}}');
});

test('a field name is never templated — it is the binding key', () => {
    const cfg = renderFormConfig({
        fields: [{ name: 'note', type: 'text', label: '{{name}}' }],
    }, { interpolate: interp({ name: 'Ada' }) });
    assert.equal(cfg.fields[0].name, 'note');
});

test('a page with no theme inherits the trigger theme; a partial theme merges on top', () => {
    const base = { primary: '#0F766E', radius: 'lg', density: 'spacious', fontScale: 'lg', appearance: 'dark' };
    assert.deepEqual(renderFormConfig({ fields: [] }, { baseTheme: base }).theme, base);
    assert.deepEqual(
        renderFormConfig({ fields: [], theme: { primary: '#1D4ED8' } }, { baseTheme: base }).theme,
        { ...base, primary: '#1D4ED8' },
    );
});

test('renderConfig is renderFormConfig on the definition trigger, uninterpolated', () => {
    // The first page is served before any run exists, so its {{...}} is literal.
    assert.deepEqual(renderConfig(def(FORM)), renderFormConfig(FORM));
});

test('an ending page may declare no fields at all', () => {
    assert.deepEqual(codes(validateFormDeclaration({ title: 'All done' }, { requireFields: false })), []);
    assert.deepEqual(codes(validateFormDeclaration({ title: 'All done', fields: [] }, { requireFields: false })), []);
    // …but an input page without fields is still incomplete. A MISSING key and
    // an EMPTY array both read as "no questions yet" rather than a shape error,
    // because a freshly-dropped node must stay saveable as a draft.
    assert.deepEqual(codes(validateFormDeclaration({ title: 'Ask' }, { requireFields: true })), ['incomplete']);
    assert.deepEqual(codes(validateFormDeclaration({ title: 'Ask', fields: [] }, { requireFields: true })), ['incomplete']);
    // A present-but-wrong value is still a shape error.
    assert.deepEqual(codes(validateFormDeclaration({ title: 'Ask', fields: 'nope' }, { requireFields: true })), ['fields_shape']);
});

test('an ending page still has its other keys validated', () => {
    const issues = validateFormDeclaration({ title: 'x'.repeat(500), theme: { primary: 'nope' } }, { requireFields: false });
    assert.ok(codes(issues).includes('title_invalid'));
    assert.ok(codes(issues).includes('theme_color'));
});

test('validateFormTrigger is validateFormDeclaration with fields required', () => {
    assert.deepEqual(validateFormTrigger(FORM), validateFormDeclaration(FORM, { requireFields: true }));
});

// ── emptyFormValues — the builder's "start from empty answers" sample ──────
//
// BFSF-408/409/434. The builder needs a payload whose keys are the form's, so
// `{{trigger.output.<field>}}` resolves while the author is still wiring the
// flow. It is coerceSubmission fed an empty body — the SAME function the public
// submit endpoint runs every visitor answer through — so shape parity with a
// real submission is guaranteed by construction rather than by remembering.

test('emptyFormValues returns every declared field, each holding its empty value', () => {
    const values = emptyFormValues(FORM);
    assert.deepStrictEqual(Object.keys(values).sort(), ['attachment', 'consent', 'email', 'message', 'topic']);
    assert.strictEqual(values.email, '');
    assert.strictEqual(values.topic, '');
    assert.strictEqual(values.message, '');
    assert.strictEqual(values.consent, false, 'an unticked checkbox is false, not ""');
    assert.strictEqual(values.attachment, null, 'an unattached file is null, not ""');
});

test('emptyFormValues has exactly the shape of a real submission that answered nothing', () => {
    // The whole point of reusing coerceSubmission: this equality cannot drift
    // when a field type is added, because there is only one implementation.
    const real = coerceSubmission(normalizeFields(FORM), {}).values;
    assert.deepStrictEqual({ ...emptyFormValues(FORM) }, { ...real });
});

test('emptyFormValues collects nothing for display-only fields', () => {
    const values = emptyFormValues({
        fields: [
            { name: 'name', type: 'text', label: 'Name' },
            { name: 'report', type: 'download', label: 'Your report' },
        ],
    });
    assert.deepStrictEqual(Object.keys(values), ['name'], 'a download button collects nothing, so it gets no key');
});

test('emptyFormValues on a form with no fields is an empty object', () => {
    assert.deepStrictEqual({ ...emptyFormValues({}) }, {});
    assert.deepStrictEqual({ ...emptyFormValues(null) }, {});
    assert.deepStrictEqual({ ...emptyFormValues({ fields: [] }) }, {});
});

// ── app_pick: a question answered from an app the FILLER can reach ─────────

const PICK_FORM = {
    title: 'Write the meeting up',
    fields: [
        { name: 'call', type: 'app_pick', label: 'Which call?', source: 'fireflies_transcript', required: true },
        { name: 'mails', type: 'app_pick', label: 'Any emails?', source: 'gmail_message', multiple: true, maxItems: 3 },
    ],
};

test('an app_pick field carries its app on the rendered config, so the picker can label itself', () => {
    const [call, mails] = normalizeFields(PICK_FORM);
    assert.strictEqual(call.source, 'fireflies_transcript');
    assert.strictEqual(call.app, 'Fireflies');
    assert.ok(call.searchHint, 'the search box needs a hint to show');
    assert.strictEqual(call.multiple, false);
    assert.strictEqual(call.maxItems, 1, 'a single-record question is maxItems 1, whatever was declared');
    assert.strictEqual(call.withText, true, 'reading the record is the default — that is the point of the field');
    assert.strictEqual(mails.multiple, true);
    assert.strictEqual(mails.maxItems, 3);
});

test('a field naming an app this install does not have is NAMED, never silently reset', () => {
    // Silently defaulting it would change what the form asks for, which the
    // author would find out from a routine that received the wrong thing.
    const issues = validateFormDeclaration({ fields: [{ name: 'x', type: 'app_pick', label: 'X', source: 'telepathy' }] });
    assert.ok(codes(issues).includes('field_pick_source'));
    assert.ok(codes(validateFormDeclaration({ fields: [{ name: 'x', type: 'app_pick', label: 'X' }] })).includes('field_pick_no_source'));
    // …and the normalizer keeps the author's choice visible while refusing to
    // resolve it, so nothing downstream treats it as a working source.
    const [f] = normalizeFields({ fields: [{ name: 'x', type: 'app_pick', label: 'X', source: 'telepathy' }] });
    assert.strictEqual(f.source, 'telepathy');
    assert.strictEqual(f.app, '');
});

test('a picked record is accepted as a reference — never as content', () => {
    const fields = normalizeFields(PICK_FORM);
    const { values, picks, errors } = coerceSubmission(fields, {
        call: { kind: 'app_pick', recordId: 'tr_1', title: 'Kickoff', text: 'I typed this myself' },
        mails: [],
    });
    assert.deepStrictEqual(errors, []);
    // The submitted `text` is dropped on the floor: the server re-reads the
    // record itself, so a hand-crafted body cannot inject content into a run.
    assert.strictEqual(values.call.text, undefined);
    assert.strictEqual(values.call.recordId, 'tr_1');
    assert.strictEqual(values.call.source, 'fireflies_transcript');
    assert.strictEqual(values.call.app, 'Fireflies');
    assert.deepStrictEqual(picks.map(p => p.field), ['call']);
    assert.strictEqual(picks[0].withText, true);
});

test('a record from a DIFFERENT app than the question asks for is refused', () => {
    // Without this a form asking for a Fireflies transcript would accept — and
    // then dutifully read — a Gmail message id.
    const fields = normalizeFields(PICK_FORM);
    const { errors } = coerceSubmission(fields, {
        call: { kind: 'app_pick', source: 'gmail_message', recordId: 'msg_1' },
    });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /the app this question asks for/);
});

test('a multiple field is bounded, de-duplicated, and reports one pick per record', () => {
    const fields = normalizeFields(PICK_FORM);
    const pick = (id) => ({ kind: 'app_pick', recordId: id, title: id });

    const ok = coerceSubmission(fields, { call: pick('tr_1'), mails: [pick('m1'), pick('m2'), pick('m1')] });
    assert.deepStrictEqual(ok.errors, []);
    assert.deepStrictEqual(ok.values.mails.map(p => p.recordId), ['m1', 'm2'], 'the same record twice is one pick');
    assert.deepStrictEqual(ok.picks.filter(p => p.field === 'mails').map(p => p.index), [0, 1]);

    const tooMany = coerceSubmission(fields, { call: pick('tr_1'), mails: [pick('a'), pick('b'), pick('c'), pick('d')] });
    assert.match(tooMany.errors[0].message, /at most 3/);
});

test('anything that is not a pick descriptor is refused', () => {
    const fields = normalizeFields(PICK_FORM);
    for (const bad of ['tr_1', 42, { recordId: 'tr_1' }, { kind: 'form_upload', fileId: 'f1' }, { kind: 'app_pick', recordId: '' }]) {
        const { errors } = coerceSubmission(fields, { call: bad });
        assert.strictEqual(errors.length, 1, `${JSON.stringify(bad)} should be refused`);
    }
});

test('an unanswered pick is empty in the shape its question has', () => {
    const fields = normalizeFields(PICK_FORM);
    const { values, errors } = coerceSubmission(fields, {});
    assert.strictEqual(values.call, null, 'one record: null');
    assert.deepStrictEqual(values.mails, [], 'several records: an empty list, so a forEach over it is valid');
    assert.strictEqual(errors.length, 1, 'only the required one complains');
    assert.deepStrictEqual({ ...emptyFormValues(PICK_FORM) }, { ...values });
});

test('a required pick that chose nothing is caught', () => {
    const fields = normalizeFields(PICK_FORM);
    const { errors } = coerceSubmission(fields, { call: [] });
    assert.match(errors[0].message, /required/);
});

test('app_pick is an input type, not a display one', () => {
    assert.ok(FIELD_TYPES.includes('app_pick'));
    const values = emptyFormValues({ fields: [{ name: 'call', type: 'app_pick', label: 'Call', source: 'fireflies_transcript' }] });
    assert.deepStrictEqual(Object.keys(values), ['call'], 'it collects, so it has a key');
});

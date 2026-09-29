const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

function definition(trigger) {
    return {
        trigger: { id: 'trg', type: 'trigger', ...trigger },
        steps: [{ id: 's1', type: 'notification', channel: 'email', to: 'a@b.nl', subject: 'hi', body: 'hi' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
}
const codesOf = (res) => (res.errors || []).concat(res.warnings || []).map(r => r.code);

test('a complete form trigger validates clean', () => {
    const res = validateDefinition(definition({
        kind: 'form',
        form: {
            title: 'Contact',
            fields: [
                { name: 'email', type: 'email', label: 'Your email', required: true },
                { name: 'note', type: 'textarea', label: 'Message' },
            ],
        },
    }));
    assert.deepEqual(codesOf(res).filter(c => c.startsWith('form.')), []);
});

test('an empty form is a completeness problem — draft-saveable, activation-blocking', () => {
    // A freshly-dropped trigger node has no form yet; hard-failing here would
    // make the node unsavable the moment you dropped it.
    assert.ok(COMPLETENESS_CODES.has('form.incomplete'));

    // At the DRAFT stage it is a warning tagged blockedAt:'activate' …
    const draft = validateDefinition(definition({ kind: 'form' }), { stage: 'draft' });
    const warned = (draft.warnings || []).find(r => r.code === 'form.incomplete');
    assert.ok(warned, 'form.incomplete is reported at draft stage');
    assert.equal(warned.severity, 'warning');
    assert.equal(warned.blockedAt, 'activate');
    assert.equal((draft.errors || []).some(r => r.code === 'form.incomplete'), false);

    // … and a hard error when activating, so an unfillable form can't go live.
    const activate = validateDefinition(definition({ kind: 'form' }));
    assert.ok((activate.errors || []).some(r => r.code === 'form.incomplete'));
    assert.equal(activate.ok, false);
});

test('a duplicate field name is a hard error — it would silently drop an answer', () => {
    const res = validateDefinition(definition({
        kind: 'form',
        form: { fields: [{ name: 'a', type: 'text', label: 'A' }, { name: 'a', type: 'text', label: 'Again' }] },
    }));
    assert.ok(codesOf(res).includes('form.field_name_duplicate'));
    assert.ok((res.errors || []).some(r => r.code === 'form.field_name_duplicate'));
});

test('an invalid field name is rejected — it could never be bound', () => {
    const res = validateDefinition(definition({
        kind: 'form',
        form: { fields: [{ name: '__proto__', type: 'text', label: 'X' }] },
    }));
    assert.ok(codesOf(res).includes('form.field_name'));
});

test('a dropdown with no choices is rejected', () => {
    const res = validateDefinition(definition({
        kind: 'form',
        form: { fields: [{ name: 'topic', type: 'select', label: 'Topic', options: [] }] },
    }));
    assert.ok(codesOf(res).includes('form.field_options'));
});

test('the issue path points at the offending field', () => {
    const res = validateDefinition(definition({
        kind: 'form',
        form: { fields: [{ name: 'ok', type: 'text', label: 'A' }, { name: '2bad', type: 'text', label: 'B' }] },
    }));
    const issue = (res.errors || []).find(r => r.code === 'form.field_name');
    assert.ok(issue);
    assert.match(issue.path, /trigger\.form\.fields\[1\]\.name/);
});

test('an invalid theme is reported without blocking the rest', () => {
    const res = validateDefinition(definition({
        kind: 'form',
        form: { fields: [{ name: 'a', type: 'text', label: 'A' }], theme: { primary: 'teal' } },
    }));
    assert.ok(codesOf(res).includes('form.theme_color'));
});

test('the kind hint lists form so the AI builder can discover it', () => {
    const res = validateDefinition({ trigger: { id: 'trg', type: 'trigger' }, steps: [], edges: [] });
    const issue = (res.errors || []).find(r => r.code === 'trigger.kind_missing');
    assert.ok(issue);
    assert.match(issue.hint, /form/);
});

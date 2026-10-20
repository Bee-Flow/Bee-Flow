'use strict';

/**
 * builder_propose_trigger's form (triggerApply.buildForm): the form-wizard
 * attributes survive the sanitiser, option objects keep their label and hint,
 * and the run-data attributes never reach the trigger (its page opens before
 * any step ran).
 *
 * Run: cd server && node --test automation/builderTools/triggerApply.wizard.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildForm, applyTrigger } = require('./stepBuilders/triggerApply');

const fieldsOf = (fields) => buildForm({ title: 'Request', fields }).fields;

test('radio, multiselect and info keep their type and attributes', () => {
    const [kind, topics, note] = fieldsOf([
        { name: 'kind', type: 'radio', label: 'I want to', options: ['report', 'request'] },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['a', 'b', 'c'], minSelected: 1, maxSelected: '2' },
        { name: 'note', type: 'info', label: 'Note', content: 'Read **this** first.' },
    ]);
    assert.equal(kind.type, 'radio');
    assert.deepEqual(kind.options, ['report', 'request']);
    assert.equal(topics.type, 'multiselect');
    assert.equal(topics.minSelected, 1);
    assert.equal(topics.maxSelected, 2);
    assert.equal(note.type, 'info');
    assert.equal(note.content, 'Read **this** first.');
});

test('option objects keep value, label and hint; plain text stays text; lengths are capped', () => {
    const [f] = fieldsOf([{
        name: 'size', type: 'select', label: 'Size',
        options: ['small', { value: 'm', label: 'Medium', hint: 'most popular' }, { value: 'solo' }, { value: 7 }, '  ', { label: 'no value' }, null, 'x'.repeat(300), { value: 'v', label: 'l'.repeat(300), hint: 'h'.repeat(300) }],
    }]);
    assert.equal(f.options[0], 'small');
    assert.deepEqual(f.options[1], { value: 'm', label: 'Medium', hint: 'most popular' });
    assert.equal(f.options[2], 'solo', 'a bare {value} is just text');
    assert.equal(f.options[3], '7');
    assert.equal(f.options[4].length, 120);
    assert.equal(f.options[5].label.length, 120);
    assert.equal(f.options[5].hint.length, 200);
    assert.equal(f.options.length, 6);
});

test('rules are kept on the types that use them and cleaned', () => {
    const [num, date, text, area, mail] = fieldsOf([
        { name: 'n', type: 'number', label: 'N', min: '0', max: 10 },
        { name: 'd', type: 'date', label: 'D', min: '2026-01-01', max: ' 2026-12-31 ' },
        { name: 't', type: 'text', label: 'T', minLength: 2, maxLength: '40', pattern: '[A-Z]{2}-[0-9]{4}', patternMessage: 'Use AB-1234' },
        { name: 'a', type: 'textarea', label: 'A', maxLength: 500 },
        { name: 'e', type: 'email', label: 'E', maxLength: 200, pattern: 'ignored' },
    ]);
    assert.equal(num.min, 0);
    assert.equal(num.max, 10);
    assert.equal(date.min, '2026-01-01');
    assert.equal(date.max, '2026-12-31');
    assert.deepEqual([text.minLength, text.maxLength, text.pattern, text.patternMessage], [2, 40, '[A-Z]{2}-[0-9]{4}', 'Use AB-1234']);
    assert.equal(area.maxLength, 500);
    assert.equal(mail.maxLength, 200);
    assert.ok(!('pattern' in mail), 'pattern is for text and textarea only');
});

test('stray rules on the wrong type are dropped, junk numbers too', () => {
    const [f, g] = fieldsOf([
        { name: 'c', type: 'checkbox', label: 'C', min: 1, minLength: 1, pattern: 'x', content: 'x', minSelected: 1 },
        { name: 'n', type: 'number', label: 'N', min: 'abc', max: '', minLength: -1 },
    ]);
    for (const k of ['min', 'minLength', 'pattern', 'content', 'minSelected']) assert.ok(!(k in f), k);
    assert.ok(!('min' in g) && !('max' in g) && !('minLength' in g));
});

test('showIf and content are kept, trimmed and capped', () => {
    const [f, g] = fieldsOf([
        { name: 'a', type: 'text', label: 'A', showIf: ' form.kind == "x" ' },
        { name: 'b', type: 'info', label: 'B', content: 'c'.repeat(5000), showIf: 's'.repeat(900) },
    ]);
    assert.equal(f.showIf, 'form.kind == "x"');
    assert.equal(g.content.length, 4000);
    assert.equal(g.showIf.length, 500);
});

test('optionsFrom and fieldsFrom never reach the trigger', () => {
    const [a, b] = fieldsOf([
        { name: 'a', type: 'select', label: 'A', optionsFrom: { ref: 'steps.x.output.rows' } },
        { name: 'b', type: 'text', label: 'B', fieldsFrom: { ref: 'steps.x.output.rows' } },
    ]);
    assert.ok(!('optionsFrom' in a) && !('fieldsFrom' in b));
});

test('applyTrigger stores the sanitised form on the draft', () => {
    const draft = {};
    applyTrigger(draft, { kind: 'form', form: { title: 'T', fields: [{ name: 'k', type: 'radio', label: 'K', options: ['a'], showIf: 'true' }] } });
    assert.equal(draft.trigger.form.fields[0].type, 'radio');
    assert.equal(draft.trigger.form.fields[0].showIf, 'true');
});

test('an info block without a label keeps it blank; other types fall back to the name', () => {
    const [note, plain] = fieldsOf([
        { name: 'note_k3f9', type: 'info', content: 'Read this first.' },
        { name: 'city', type: 'text' },
    ]);
    assert.equal(note.label, '');
    assert.equal(plain.label, 'city');
});

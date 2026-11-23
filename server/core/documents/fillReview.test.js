'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanFindings, filledFields, openFindings, reviewOf, reviewView, withReview, withoutFindings, MAX_FINDINGS, MAX_REASON } = require('./fillReview.mts');

const CONTRACT = { parameters: [
    { key: 'scope', type: 'text', label: 'Scope', required: true },
    { key: 'price', type: 'number', label: 'Price', required: true },
    { key: 'start', type: 'date', label: 'Start' },
    { key: 'extra', type: 'text', label: 'Extra' },
] };
const VALUES = { scope: 'we do the thing asap', price: 12, start: '2026-01-05' };
const keys = (list) => list.map((f) => f.key);
const reviewed = (findings) => withReview({ sampleValues: VALUES }, { at: '2026-11-23T09:00:00.000Z', by: 'u1', source: 'form', checked: 3, findings });

test('a check looks at the fields that have a value', () => {
    assert.deepEqual(keys(filledFields(CONTRACT, VALUES)), ['scope', 'price', 'start']);
});

test('a rewrite is kept only for a text field, with a wording that differs; a doubt only with its reason', () => {
    const findings = cleanFindings([
        { key: 'scope', kind: 'rewrite', suggestion: ' We carry out the work as soon as possible. ', reason: 'Written out.' },
        { key: 'price', kind: 'rewrite', suggestion: '13', reason: 'A number is not reworded.' },
        { key: 'start', kind: 'doubt', reason: 'A Monday in the holidays.' },
        { key: 'price', kind: 'doubt', reason: '' },
        { key: 'extra', kind: 'doubt', reason: 'Empty: nothing to remark on.' },
        { key: 'nope', kind: 'doubt', reason: 'Unknown field.' },
        { key: 'start', kind: 'doubt', reason: 'A second remark on the same field.' },
        { key: 'scope', kind: 'praise', reason: 'Not a kind.' },
        'not an object',
    ], CONTRACT, VALUES);
    assert.deepEqual(findings.map((f) => [f.key, f.kind]), [['scope', 'rewrite'], ['start', 'doubt']]);
    assert.equal(findings[0].suggestion, 'We carry out the work as soon as possible.');
    assert.equal(findings[1].suggestion, undefined, 'a doubt never carries a value: the assistant does not invent one');
    assert.deepEqual(cleanFindings([{ key: 'scope', kind: 'rewrite', suggestion: 'we do the thing asap', reason: 'Same.' }], CONTRACT, VALUES), []);
    assert.deepEqual(cleanFindings('nope', CONTRACT, VALUES), []);
});

test('what a model hands in is bounded', () => {
    const many = Array.from({ length: MAX_FINDINGS + 20 }, (_, i) => ({ key: `f${i}`, type: 'text', label: `F${i}`, required: false }));
    const values = Object.fromEntries(many.map((f) => [f.key, 'x']));
    const raw = many.map((f) => ({ key: f.key, kind: 'doubt', reason: 'r'.repeat(MAX_REASON + 50) }));
    const findings = cleanFindings(raw, { parameters: many }, values);
    assert.equal(findings.length, MAX_FINDINGS);
    assert.equal(findings[0].reason.length, MAX_REASON);
});

test('a remark is gone once its field has another value, whoever changed it', () => {
    const settings = reviewed(cleanFindings([
        { key: 'scope', kind: 'rewrite', suggestion: 'We carry out the work.', reason: 'Written out.' },
        { key: 'price', kind: 'doubt', reason: 'Low for this scope.' },
    ], CONTRACT, VALUES));
    assert.deepEqual(keys(openFindings(settings, VALUES)), ['scope', 'price']);
    assert.deepEqual(keys(openFindings(settings, { ...VALUES, price: 1200 })), ['scope']);
    assert.deepEqual(keys(openFindings(settings, { ...VALUES, scope: undefined })), ['price']);
    const view = reviewView(settings, { ...VALUES, price: 1200 });
    assert.equal(view.checked, 3);
    assert.deepEqual(view.findings, [{ key: 'scope', kind: 'rewrite', reason: 'Written out.', suggestion: 'We carry out the work.' }]);
});

test('dismissing takes the remark off those fields and keeps the document checked', () => {
    const settings = reviewed(cleanFindings([{ key: 'price', kind: 'doubt', reason: 'Low.' }, { key: 'start', kind: 'doubt', reason: 'A holiday.' }], CONTRACT, VALUES));
    const next = withoutFindings(settings, ['price', 'nope']);
    assert.deepEqual(keys(reviewOf(next).findings), ['start']);
    assert.equal(withoutFindings(settings, ['nope']), settings, 'nothing to drop: the same settings, so nothing is saved');
    assert.equal(withoutFindings(settings, []), settings);
    assert.equal(withoutFindings({ sampleValues: VALUES }, ['price']).fillReview, undefined);
});

test('a document that was never checked has no review; a broken one is read as far as it goes', () => {
    assert.equal(reviewOf({}), null);
    assert.equal(reviewOf(null), null);
    assert.equal(reviewView({}, VALUES), null);
    const odd = reviewOf({ fillReview: { at: 'now', findings: [{ key: 'scope', kind: 'doubt', reason: 'x', was: '"a"' }, { key: 'price' }, null] } });
    assert.deepEqual(keys(odd.findings), ['scope']);
    assert.equal(odd.source, 'form');
});

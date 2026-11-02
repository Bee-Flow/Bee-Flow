/**
 * Gmail's label syntax on an Outlook mailbox: label: terms become a categories
 * filter, OR between labels means either, labels side by side mean both.
 *
 * Run: cd server && node --test services/email/outlookQuery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseLabelQuery, categoriesFilter, matchesLabelGroups, outlookListQuery } = require('./outlookQuery.mts');

const decode = (qs) => Object.fromEntries(new URLSearchParams(qs.replace(/%20/g, '+')));

test('labels side by side are AND, OR between labels is either', () => {
    assert.deepStrictEqual(parseLabelQuery('label:a label:b').groups, [['a'], ['b']]);
    assert.deepStrictEqual(parseLabelQuery('label:a OR label:b').groups, [['a', 'b']]);
    assert.deepStrictEqual(parseLabelQuery('label:a OR label:b label:c').groups, [['a', 'b'], ['c']]);
    assert.deepStrictEqual(parseLabelQuery('label:"Daniel B" OR label:Kees').groups, [['Daniel B', 'Kees']]);
});

test('text stays text, an OR between words stays in it, and a lone label leaves none', () => {
    assert.deepStrictEqual(parseLabelQuery('label:a offerte'), { text: 'offerte', groups: [['a']] });
    assert.deepStrictEqual(parseLabelQuery('offerte OR aanvraag'), { text: 'offerte OR aanvraag', groups: [] });
    assert.deepStrictEqual(parseLabelQuery('label:daniel'), { text: '', groups: [['daniel']] });
    assert.deepStrictEqual(parseLabelQuery(''), { text: '', groups: [] });
});

test('the OData clause, with a quote in a name escaped', () => {
    assert.strictEqual(categoriesFilter([['a', 'b'], ["O'Neill"]]),
        "categories/any(c:c eq 'a' or c eq 'b') and categories/any(c:c eq 'O''Neill')");
    assert.strictEqual(categoriesFilter([]), null);
});

test('labels only: one $filter with the date, ordered, nothing left to filter here', () => {
    const { qs, labelGroups } = outlookListQuery({
        query: 'label:daniel OR label:kees', sinceIso: '2026-11-01T00:00:00.000Z', select: 'id', top: 50,
    });
    const p = decode(qs);
    assert.strictEqual(p.$filter, "receivedDateTime ge 2026-11-01T00:00:00.000Z and categories/any(c:c eq 'daniel' or c eq 'kees')");
    assert.strictEqual(p.$orderby, 'receivedDateTime desc');
    assert.strictEqual(p.$search, undefined);
    assert.ok(!qs.includes('+'), 'spaces travel as %20');
    assert.deepStrictEqual(labelGroups, []);
});

test('labels and text: $search for the text, the labels come back to apply to the results', () => {
    const { qs, labelGroups } = outlookListQuery({ query: 'label:daniel offerte', sinceIso: null, select: 'id', top: 50 });
    const p = decode(qs);
    assert.strictEqual(p.$search, '"offerte"');
    assert.strictEqual(p.$filter, undefined);
    assert.deepStrictEqual(labelGroups, [['daniel']]);
});

test('matching categories ignores case and needs every group', () => {
    assert.strictEqual(matchesLabelGroups('Daniel,Spoed', [['daniel']]), true);
    assert.strictEqual(matchesLabelGroups(['Kees'], [['daniel', 'kees']]), true);
    assert.strictEqual(matchesLabelGroups('Daniel', [['daniel'], ['spoed']]), false);
    assert.strictEqual(matchesLabelGroups('', [['daniel']]), false);
    assert.strictEqual(matchesLabelGroups('', []), true);
});

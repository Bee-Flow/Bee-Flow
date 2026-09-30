'use strict';

/**
 * The three-way merge of a designed document's body (sectionMerge.js):
 * what merges on its own, what is a conflict, and that a merge never changes
 * a byte nobody touched.
 *
 * Run: cd server && node --test core/documents/sectionMerge.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { mergeBodies, resolveParts } = require('./sectionMerge');

const S = (id, ...paragraphs) => `<section data-doc-section="${id}"><h2>${id === 'pricing' ? 'Pricing' : id}</h2>${paragraphs.map(p => `<p>${p}</p>`).join('')}</section>\n`;

test('different sections changed by two people merge, and the other side\'s sections are named', () => {
    const base = S('intro', 'a') + S('pricing', 'b') + S('terms', 'c');
    const mine = S('intro', 'mine') + S('pricing', 'b') + S('terms', 'c');
    const theirs = S('intro', 'a') + S('pricing', 'b') + S('terms', 'theirs');
    const r = mergeBodies(base, mine, theirs);
    assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(r.html, S('intro', 'mine') + S('pricing', 'b') + S('terms', 'theirs'));
    assert.deepStrictEqual(r.fromOthers, ['terms']);
    assert.strictEqual(r.othersOutsideSections, false);
});

test('different paragraphs of the same section merge one level down', () => {
    const base = S('pricing', 'one', 'middle', 'three');
    const r = mergeBodies(base, S('pricing', 'ONE', 'middle', 'three'), S('pricing', 'one', 'middle', 'THREE'));
    assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(r.html, S('pricing', 'ONE', 'middle', 'THREE'));
    assert.deepStrictEqual(r.fromOthers, ['pricing']);
});

test('the same paragraph changed differently is a conflict, labelled by its section, with all three sides', () => {
    const r = mergeBodies(S('pricing', 'b'), S('pricing', 'mine'), S('pricing', 'theirs'));
    assert.strictEqual(r.conflicts, 1);
    assert.strictEqual(r.html, null);
    const c = r.parts.find(p => p.kind === 'conflict');
    assert.strictEqual(c.label, 'Pricing');
    assert.deepStrictEqual([c.base, c.mine, c.theirs], ['<p>b</p>', '<p>mine</p>', '<p>theirs</p>']);
    assert.strictEqual(resolveParts(r.parts, { [c.key]: 'theirs' }), S('pricing', 'theirs'));
    assert.strictEqual(resolveParts(r.parts, {}), S('pricing', 'mine'), 'unpicked keeps mine');
});

test('both sides making the same change is not a conflict', () => {
    const r = mergeBodies(S('a', 'x'), S('a', 'y'), S('a', 'y'));
    assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(r.html, S('a', 'y'));
});

test('a section added on one side and a paragraph edited on the other both survive', () => {
    const base = S('intro', 'a') + S('terms', 'c');
    const mine = S('intro', 'a') + S('extra', 'new') + S('terms', 'c');
    const theirs = S('intro', 'A') + S('terms', 'c');
    const r = mergeBodies(base, mine, theirs);
    assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(r.html, S('intro', 'A') + S('extra', 'new') + S('terms', 'c'));
});

test('a section deleted on one side and edited on the other is a conflict', () => {
    const base = S('intro', 'a') + S('terms', 'c');
    const r = mergeBodies(base, S('intro', 'a'), S('intro', 'a') + S('terms', 'changed'));
    assert.strictEqual(r.conflicts, 1);
});

test('a body without sections merges by paragraph, and reports changes outside sections', () => {
    const r = mergeBodies('<p>1</p><p>2</p><p>3</p>', '<p>1x</p><p>2</p><p>3</p>', '<p>1</p><p>2</p><p>3y</p>');
    assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(r.html, '<p>1x</p><p>2</p><p>3y</p>');
    assert.strictEqual(r.othersOutsideSections, true);
});

test('template tokens inside tables and entities survive a merge byte for byte', () => {
    const table = '<table><tbody>{{#each lines}}<tr><td>{{name}} &amp; co&nbsp;</td></tr>{{/each}}</tbody></table>';
    const base = `<p>intro</p>\n${table}\n<p>end</p>`;
    const r = mergeBodies(base, base.replace('intro', 'Intro!'), base.replace('end', 'The end'));
    assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(r.html, `<p>Intro!</p>\n${table}\n<p>The end</p>`);
});

test('the trivial cases answer without parsing', () => {
    assert.strictEqual(mergeBodies('a', 'b', 'b').html, 'b');
    assert.strictEqual(mergeBodies('a', 'a', 'c').html, 'c');
    assert.strictEqual(mergeBodies('a', 'b', 'a').html, 'b');
});

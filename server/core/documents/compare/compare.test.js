'use strict';
/**
 * The document compare engine, per family: decks slide by slide (matched by
 * title, then by likeness; added, removed and changed slides, the look),
 * spreadsheets by tab, row, column and cell, text by block with the word
 * diff inside, and the alignment helper underneath all three.
 *
 * Run: cd server && node --test core/documents/compare/compare.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { alignSequences } = require('./align.mts');
const { diffWords, diffLines, bagSimilarity } = require('./words.mts');
const { compareDecks, slideLines, compareLook } = require('./deckCompare.mts');
const { compareSheets, compareTab } = require('./sheetCompare.mts');
const { compareText } = require('./textCompare.mts');
const { compareDocuments, familyOf, NotComparableError } = require('./index.mts');
const { normalizeDeck } = require('../deckModel');
const { evaluateSheet } = require('../../../shared/expr/sheet.mjs');

// ── alignment ─────────────────────────────────────────────────────────

const exact = { keyA: (x) => x, keyB: (x) => x, similarity: () => 0, minSimilarity: 1 };

test('align: prefix, suffix and an inserted and a removed item', () => {
    const steps = alignSequences(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'], exact);
    assert.deepStrictEqual(steps.map((s) => s.op), ['match', 'delete', 'insert', 'match', 'match', 'insert']);
});

test('align: alike items in a gap are paired, the rest added or removed', () => {
    const steps = alignSequences(['red apple', 'blue sky'], ['red apples', 'green field'], {
        keyA: (x) => x, keyB: (x) => x, similarity: bagSimilarity, minSimilarity: 0.4,
    });
    assert.deepStrictEqual(steps.map((s) => s.op), ['pair', 'delete', 'insert']);
});

test('align: a null key never matches', () => {
    const steps = alignSequences([null, null], [null], { ...exact, keyA: () => null, keyB: () => null });
    assert.deepStrictEqual(steps.map((s) => s.op), ['delete', 'delete', 'insert']);
});

test('align: every item of both sides appears exactly once, in order', () => {
    const a = 'the quick brown fox jumps over the lazy dog'.split(' ');
    const b = 'a quick red fox jumped over the dog again'.split(' ');
    const steps = alignSequences(a, b, { keyA: (x) => x, keyB: (x) => x, similarity: bagSimilarity, minSimilarity: 0.4 });
    const left = steps.filter((s) => 'ai' in s).map((s) => s.ai);
    const right = steps.filter((s) => 'bi' in s).map((s) => s.bi);
    assert.deepStrictEqual(left, a.map((_, i) => i));
    assert.deepStrictEqual(right, b.map((_, i) => i));
});

// ── words ─────────────────────────────────────────────────────────────

test('words: a changed word is a delete and an insert, the rest equal', () => {
    const w = diffWords('Revenue grew by 10% this year', 'Revenue grew by 12% this year');
    assert.strictEqual(w.filter((x) => x.op !== 'equal').map((x) => `${x.op}:${x.text}`).join(' '), 'delete:10 insert:12');
    assert.strictEqual(w.filter((x) => x.op !== 'insert').map((x) => x.text).join(''), 'Revenue grew by 10% this year');
    assert.strictEqual(w.filter((x) => x.op !== 'delete').map((x) => x.text).join(''), 'Revenue grew by 12% this year');
});

test('words: lines are equal, modified (with words), added or removed', () => {
    const lines = diffLines(['• one', '• two items here', '• three'], ['• one', '• two items there', '• four']);
    assert.deepStrictEqual(lines.map((l) => l.op), ['equal', 'modify', 'delete', 'insert']);
    assert.ok(lines[1].words.some((w) => w.op === 'insert' && w.text === 'there'));
});

// ── decks ─────────────────────────────────────────────────────────────

const deck = (md) => normalizeDeck(md);
const BEFORE = deck(`# Quarterly review
For the board

## Results
- Revenue grew 10%
- Costs flat

## Plans
- Hire two people
- Open an office

## Risks
- Supply chain
`);
const AFTER = deck(`# Quarterly review
For the board

## Results
- Revenue grew 12%
- Costs flat

## Plans
- Hire two people
- Open an office

## Timeline
- Q1 kick-off
- Q2 launch
`);

test('deck: slides matched by title; one changed, one added, one removed, the rest equal', () => {
    const r = compareDecks({ deck: BEFORE, look: {}, houseStyle: true }, { deck: AFTER, look: {}, houseStyle: true });
    assert.strictEqual(r.family, 'deck');
    assert.deepStrictEqual(r.slides.map((s) => s.op), ['equal', 'changed', 'equal', 'removed', 'added']);
    assert.deepStrictEqual(r.summary, { changed: 1, added: 1, removed: 1, unchanged: 2, lookChanged: false, wordsAdded: r.summary.wordsAdded, wordsRemoved: r.summary.wordsRemoved });
    const results = r.slides[1];
    assert.strictEqual(results.left.title, 'Results');
    assert.strictEqual(results.left.index, 1, 'the cover is 0, so slide 1 is the viewer\'s frame 1');
    const changedLine = results.lines.find((l) => l.op === 'modify');
    assert.ok(changedLine.words.some((w) => w.op === 'delete' && w.text === '10'));
    assert.ok(changedLine.words.some((w) => w.op === 'insert' && w.text === '12'));
});

test('deck: a renamed slide with the same content is paired as changed, not removed and added', () => {
    const a = deck('# D\n\n## Our plans\n- Hire two people\n- Open an office in the north\n');
    const b = deck('# D\n\n## The plan\n- Hire two people\n- Open an office in the north\n');
    const r = compareDecks({ deck: a, look: {}, houseStyle: true }, { deck: b, look: {}, houseStyle: true });
    assert.deepStrictEqual(r.slides.map((s) => s.op), ['equal', 'changed']);
    assert.ok(r.slides[1].lines.some((l) => l.op === 'modify' && /plan/.test(l.after)));
});

test('deck: identical decks are all equal; a new template shows only as a look change', () => {
    const r = compareDecks(
        { deck: BEFORE, look: { preset: 'band' }, houseStyle: true },
        { deck: BEFORE, look: { preset: 'minimal', accent: '#112233', template: { backgrounds: ['x'] } }, houseStyle: true },
    );
    assert.ok(r.slides.every((s) => s.op === 'equal'));
    assert.strictEqual(r.summary.lookChanged, true);
    assert.deepStrictEqual(r.look.map((l) => l.key).sort(), ['accent', 'preset', 'template']);
    assert.deepStrictEqual(r.look.find((l) => l.key === 'template'), { key: 'template', before: '', after: 'custom' });
    assert.ok(!JSON.stringify(r.look).includes('backgrounds'), 'the template picture never leaves the engine');
});

test('deck: two different custom templates are reported as replaced', () => {
    const look = compareLook({ template: { a: 1 } }, { template: { a: 2 } }, { left: true, right: true });
    assert.deepStrictEqual(look, [{ key: 'template', before: 'custom', after: 'custom', replaced: true }]);
});

test('deck: a slide\'s lines cover tables, charts, stats, quotes, cards and notes', () => {
    const d = deck(`# T

## Numbers
| Region | Sales |
| --- | --- |
| North | 10 |

## Chart
\`\`\`chart
type: bar
labels: Q1, Q2
Sales: 1, 2
\`\`\`

## KPIs
\`\`\`stats
€ 1M | Revenue | +5%
\`\`\`

## Quote
> Less is more
> — An architect

## Cards
### Fast
Quick to start
### Safe
Nothing leaves
### Open
Fair code

<!-- notes: say hello -->
`);
    const all = d.slides.map(slideLines);
    assert.ok(all[0].includes('North | 10'));
    assert.ok(all[1].some((l) => l.startsWith('Chart (bar)')) && all[1].includes('Sales: 1, 2'));
    assert.ok(all[2].includes('€ 1M — Revenue (+5%)'));
    assert.ok(all[3].some((l) => l.includes('Less is more')));
    assert.ok(all[4].includes('Fast: Quick to start'));
    assert.ok(all[4].includes('Notes: say hello'));
});

// ── sheets ────────────────────────────────────────────────────────────

const tab = (name, cells) => {
    const shown = evaluateSheet(cells);
    return { name, cells, display: Object.fromEntries(Object.entries(shown).map(([k, v]) => [k, v.display])) };
};

test('sheet: an inserted row is one added row, not every row below it changed', () => {
    const before = tab('Data', { A1: 'Name', B1: 'Qty', A2: 'Bolt', B2: '4', A3: 'Nut', B3: '8' });
    const after = tab('Data', { A1: 'Name', B1: 'Qty', A2: 'Bolt', B2: '4', A3: 'Washer', B3: '2', A4: 'Nut', B4: '9' });
    const t = compareTab(before, after);
    assert.deepStrictEqual(t.rows.map((r) => r.op), ['equal', 'equal', 'added', 'changed']);
    assert.deepStrictEqual(t.stats, { cellsChanged: 1, rowsAdded: 1, rowsRemoved: 0, columnsAdded: 0, columnsRemoved: 0 });
    const changed = t.rows[3];
    assert.deepStrictEqual([changed.left, changed.right], [3, 4]);
    assert.deepStrictEqual(changed.cells, [{ col: 1, op: 'changed', before: '8', after: '9' }]);
});

test('sheet: columns matched by header; an inserted column is one added column', () => {
    const before = tab('S', { A1: 'Name', B1: 'Qty', A2: 'Bolt', B2: '4' });
    const after = tab('S', { A1: 'Name', B1: 'Colour', C1: 'Qty', A2: 'Bolt', B2: 'Red', C2: '4' });
    const t = compareTab(before, after);
    assert.deepStrictEqual(t.columns.map((c) => `${c.op}:${c.left}->${c.right}`), ['equal:A->A', 'added:null->B', 'equal:B->C']);
    assert.strictEqual(t.stats.cellsChanged, 0);
    assert.strictEqual(t.stats.columnsAdded, 1);
});

test('sheet: a formula that changed is a changed cell even when its value is the same, and carries both formulas', () => {
    const before = tab('S', { A1: '2', B1: '=A1*2' });
    const after = tab('S', { A1: '2', B1: '=A1+2' });
    const t = compareTab(before, after);
    assert.deepStrictEqual(t.rows[0].cells, [{ col: 1, op: 'changed', before: '4', after: '4', beforeFormula: '=A1*2', afterFormula: '=A1+2' }]);
});

test('sheet: tabs matched by name, a renamed tab paired by position, an extra tab added', () => {
    const r = compareSheets(
        { tabs: [tab('Orders', { A1: 'x' }), tab('Old name', { A1: 'y' })] },
        { tabs: [tab('Orders', { A1: 'x' }), tab('New name', { A1: 'y' }), tab('Extra', { A1: 'z' })] },
    );
    assert.deepStrictEqual(r.tabs.map((t) => `${t.op}:${t.leftName}->${t.rightName}`), ['equal:Orders->Orders', 'equal:Old name->New name', 'added:null->Extra']);
    assert.strictEqual(r.summary.tabsAdded, 1);
});

test('sheet: a big tab lists only the changed rows and their neighbours', () => {
    const cells = {};
    for (let r = 1; r <= 900; r++) cells[`A${r}`] = `row ${r}`;
    const after = { ...cells, A450: 'changed' };
    const t = compareTab(tab('S', cells), tab('S', after));
    assert.ok(t.rows.length <= 3, `listed ${t.rows.length}`);
    assert.ok(t.hiddenRows >= 897);
    assert.strictEqual(t.stats.cellsChanged, 1);
});

// ── text ──────────────────────────────────────────────────────────────

test('text: inserted, deleted and changed paragraphs, words inside the changed one', () => {
    const r = compareText(
        { html: '<p>Intro stays.</p><p>The price is ten euro.</p><p>Gone soon.</p>' },
        { html: '<p>Intro stays.</p><p>The price is twelve euro.</p><p>A new closing line.</p>' },
    );
    assert.strictEqual(r.family, 'text');
    assert.strictEqual(r.truncated, false);
    const ops = r.blocks.map((b) => b.op);
    assert.strictEqual(ops[0], 'equal');
    assert.ok(ops.includes('modify'));
    const mod = r.blocks.find((b) => b.op === 'modify');
    assert.ok(mod.words.some((w) => w.op === 'insert' && /twelve/.test(w.text)));
    assert.strictEqual(r.summary.changed + r.summary.added + r.summary.removed >= 2, true);
});

test('text: a page against a presentation outline compares as text', () => {
    const r = compareDocuments(
        { docType: 'page', bodyHtml: '<h2>Results</h2><ul><li>Revenue grew 10%</li></ul>' },
        { docType: 'presentation', bodyHtml: '## Results\n- Revenue grew 12%\n' },
    );
    assert.strictEqual(r.family, 'text');
    assert.ok(r.blocks.some((b) => b.op !== 'equal'));
});

// ── dispatch ──────────────────────────────────────────────────────────

test('family: presentation = deck, spreadsheet = sheet, everything else text', () => {
    assert.deepStrictEqual(['presentation', 'spreadsheet', 'page', 'invoice', 'document', undefined].map(familyOf), ['deck', 'sheet', 'text', 'text', 'text', 'text']);
});

test('dispatch: a spreadsheet against a page is refused with a clear code', () => {
    assert.throws(() => compareDocuments({ docType: 'spreadsheet', sheet: { tabs: [] } }, { docType: 'page', bodyHtml: '<p>x</p>' }),
        (e) => e instanceof NotComparableError && e.status === 422 && e.code === 'documents_not_comparable');
});

test('dispatch: two decks compare slide by slide', () => {
    const r = compareDocuments(
        { docType: 'presentation', deck: BEFORE, look: {}, houseStyle: true },
        { docType: 'presentation', deck: AFTER, look: {}, houseStyle: true },
    );
    assert.strictEqual(r.family, 'deck');
});

// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the deck model, through its public
 * entries normalizeDeck, normalizeSlide and deckToMarkdown: the whole
 * normalised deck (or the error), every warning in order, and the outline it
 * writes back, for markdown outlines and JSON slides that reach every branch
 * of the line parser (fences, comments, notes, columns, images, bullets,
 * quotes, tables), of the slide assembly (chart, tiles, steps, columns versus
 * cards versus folding back, the layout hint), of the JSON reader (every
 * spelling of every field), of the clamp (every cap, every layout that lost
 * its content) and of the outline writer. Each input runs with the default
 * limits and with tight ones; the clamp also gets slides no parser produces.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/documents/deckModel.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { normalizeDeck, normalizeSlide, deckToMarkdown, DECK_LIMITS, _test: { clampDeck } } = require('./deckModel');

const GOLDEN = path.join(__dirname, 'deckModel.characterisation.golden.json');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BIG_PNG = `data:image/png;base64,${'QUJD'.repeat(40)}`;
const KEY = 'users/u1/images/pic.png';
const PROXY = '/api/storage/file/users/u1/images/pic%20one.png';
const REMOTE = 'https://example.com/x.png';

const TIGHT = /** @type {typeof DECK_LIMITS} */ (/** @type {unknown} */ ({
    ...DECK_LIMITS, maxSlides: 40, maxBulletsPerSlide: 3, maxBulletChars: 12, maxTitleChars: 10, maxSubtitleChars: 14, maxBodyChars: 20,
    maxNotesChars: 16, maxQuoteChars: 12, maxTableRows: 2, maxTableCols: 2, maxCellChars: 6, maxImageBytes: 80,
}));

const md = (/** @type {string[]} */ ...ls) => ls.join('\n');
const F = '```';

/** Markdown outlines. @type {Record<string, string>} */
const MARKDOWN = {
    coverOnly: '# Only a title',
    coverSubtitleIntro: md('# Deck', '', 'The subtitle paragraph.', '', 'An intro paragraph.', '- intro bullet', '<!-- notes: cover note -->', '## One', '- a'),
    coverIntroTableQuoteImage: md('# Deck', '| a | b |', '|---|---|', '| 1 | 2 |', '> said', `![pic](${KEY})`),
    noTitleSections: md('## A', '- x', '## B', 'body text'),
    secondH1: md('# T', '## A', '- x', '# Second h1', '- y'),
    hrBreaks: md('# T', '## A', '- x', '---', '', 'loose text', '***', '___', '- after two rules', '---'),
    bullets: md('## B', '- one', '  - sub', '\t- tab sub', ' - one space', '* star', '+ plus', '1. first', '2) second', '- **bold** _it_ `code` [link](http://x)'),
    blankLines: md('## B', 'para one', '', '', 'para two', '', '- b', ''),
    notesParagraph: md('## N', '- a', 'Notes: first', 'second line', '- not a bullet', '## M', 'Speaker notes:', 'only later', '## O', 'notities: nl', '## P', 'Sprekersnotities: x'),
    notesComments: md('## N', '<!-- notes: one line -->', '<!-- notes: open', 'middle', 'end --> trailing', '- a', '<!-- notes: never closed', '- swallowed'),
    hintComments: md('## H', '<!-- layout: Two-Column -->', '<!-- style: Accent -->', '<!-- chart: bar -->', '- a', '## H2', '<!-- style: purple -->', '<!-- layout: nonsense -->', 'x'),
    fenceChart: md('## C', `${F}chart`, 'type: bar', 'labels: Q1, Q2', 'Omzet: 10, 20', F, `${F}chart`, 'A: 1', F, '- b'),
    fenceStats: md('## S', `${F}stats`, '€ 1,2M | Omzet | +12% | trending-up', '42 | Users | | no-such-icon', F, `${F}kpi`, '1 | x', F),
    fenceKpiEmpty: md('## S', `${F}kpi`, '', F, '- left over'),
    fenceCode: md('## Code', `${F}js`, '  const a = 1;', '', F, '~~~', 'tilde block', '~~~', `${F}${F}`, 'four ticks', F, 'still inside', `${F}${F}`),
    fenceNotClosedByLang: md('## Code', F, 'a', `${F}js`, 'b', F, 'after'),
    fenceUnclosedChart: md('## C', `${F}chart`, 'A: 1', 'B: 2'),
    fenceUnclosedStats: md('## C', `${F}stats`, '1 | a'),
    fenceUnclosedOther: md('## C', '### Col', `${F}text`, '  kept  '),
    fenceUnclosedSecondChart: md('## C', `${F}chart`, 'A: 1', F, `${F}chart`, 'B: 2'),
    fenceUnclosedSecondStats: md('## C', `${F}stats`, '1 | a', F, `${F}stats`, '2 | b'),
    fenceInsideNotes: md('## N', 'Notes: n', F, 'not a fence'),
    fenceInsideComment: md('## N', '<!-- notes: a', F, 'b -->', '- x'),
    chartHintTable: md('## C', '<!-- chart: line -->', '| m | v |', '|---|---|', '| jan | 1 |', '| feb | 2 |'),
    chartHintTextTable: md('## C', '<!-- chart: pie -->', '| m | v |', '|---|---|', '| jan | none |'),
    chartHintAlone: md('## C', '<!-- chart -->', '<!-- chart: donut -->', '- a'),
    chartHintWithFence: md('## C', '<!-- chart: area -->', `${F}chart`, 'labels: a, b', 'S: 1, 2', F),
    chartNoNumbers: md('## C', `${F}chart`, 'labels: a, b', 'S: x, y', F, '- still a slide'),
    tables: md('## T', '| a | b |', '| :-- | --: |', '| 1 | **2** |', '| 3 | 4 |', 'text', '| c |', '|---|', '| 5 |', '| lone | row |', 'not a sep'),
    tableWide: md('## T', '| a | b | c |', '|---|---|---|', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |', '| 7 | 8 | 9 |'),
    quotes: md('## Q', '> first line', '> second', '>', '> — The CEO', '## Q2', '> -- only attribution', '## Q3', '>', '## Q4', '> – en dash', '> text after'),
    images: md('## I', `![a](${PNG})`, `![b](${KEY})`, '## J', `![r](${REMOTE})`, `![p](${PROXY} "title")`, '## K', '![bad](/api/storage/file/users/%E0%A4%A)', '![up](/api/storage/file/users/../x)'),
    imageTooBig: md('## I', `![a](${BIG_PNG})`),
    twoColumns: md('## Two', '### Left', '- a', '- b', '### Right', 'body only', 'more body'),
    twoColumnsEmptyOne: md('## Two', '### Left', '- a', '### '),
    twoAsCards: md('## Two', '<!-- layout: cards -->', '### One {icon: wifi-off}', 'text', `![p](${KEY})`, '### Two [icon: nope]', '- b', `![q](${PNG})`, `![extra](${KEY})`, `![third](${KEY})`),
    threeCards: md('## Cards', '### A {icon: shield}', 'alpha', '- a1', '### B', 'beta', '', 'beta two', '### C', `![c](${REMOTE})`),
    sixCards: md('## Cards', '### A', 'a', '### B', 'b', '### C', 'c', '### D', 'd', '### E', 'e', '### F', 'f'),
    sevenColumnsFold: md('## Fold', 'lead', '### A', '- a', '### B', 'b body', '### C', '### D', '- d', '### E', '- e', '### F', '- f', '### G', '- g'),
    oneColumnFold: md('## Fold', '### Only', '- a', 'col body'),
    oneColumnFoldNoBody: md('## Fold', '### Only', 'col body'),
    cardWithOnlyTitle: md('## Cards', '### A', '### B', '### C'),
    timelines: md('## T', '<!-- layout: timeline -->', '- Kick-off — plan', '- Build', '## S', '<!-- layout: steps -->', '- a', '## P', '<!-- layout: process -->', '- p', '## Empty', '<!-- layout: timeline -->', 'no bullets'),
    forcedLayouts: md('## A', '<!-- layout: table -->', '- no table', '## B', '<!-- layout: image -->', '## C', '<!-- layout: quote -->', 'c', '## D', '<!-- layout: two_column -->', 'd',
        '## E', '<!-- layout: cards -->', 'e', '## F', '<!-- layout: chart -->', 'f', '## G', '<!-- layout: stats -->', 'g', '## H', '<!-- layout: closing -->', 'h', '## I', '<!-- layout: title -->', '## J', '<!-- layout: section -->', '- j'),
    overflow: md('# Deck', '## Many', 'intro', ...Array.from({ length: 23 }, (_, i) => `- bullet ${i + 1}`), '<!-- notes: n -->'),
    longTexts: md(`# ${'Title '.repeat(40)}`, 'sub '.repeat(80), `## ${'Heading '.repeat(30)}`, `- ${'bullet '.repeat(60)}`, 'body '.repeat(400), `> ${'quote '.repeat(120)}`, `> — ${'who '.repeat(60)}`, `<!-- notes: ${'note '.repeat(900)} -->`),
    emptySlides: md('# T', '## ', '', '## Real', '- a', '---', '', '<!-- style: dark -->'),
    crlf: '# T\r\n## A\r- x\r\n- y',
    styleAndEverything: md('# All', '## Mixed', '<!-- style: dark -->', 'body', `![i](${KEY})`, '| a | b |', '|---|---|', '| 1 | 2 |', `${F}chart`, 'type: donut', 'title: Parts', 'unit: %', 'A: 60', 'B: 40', F,
        `${F}stats`, '1 | one | +1', F, '- b', '> q', '> — w', '<!-- notes: n1 -->', '<!-- notes: n2 -->'),
    chartOptions: md('## C', `${F}chart`, 'type: column', 'stacked: true', 'showValues: false', 'labels: a, b; c', 'One, two: 1, 2', 'Three: 3, 4', F),
    whitespaceOnly: '   \n  ',
    notesWithBlankLines: md('## N', '- a', '<!-- notes: first', '', '', '', 'last -->'),
    markupOnlyTexts: md('## B', '- <b></b>', '- kept', '## Cards', '### A', '<i></i>', '### B', 'b', '### C', 'c', '## Pair', '<!-- layout: cards -->', '### A', '<i></i>', '### B', 'b',
        '## Cols', '### ', '- <b></b>', '### L', '- a', '## Title only', '### Left', '### Right', '- b'),
    columnCaps: md('## Cols', `### ${'Left heading '.repeat(12)}`, ...Array.from({ length: 13 }, (_, i) => `- l${i}`), '### Right', '- r'),
    fenceProseShape: md('## Code', `${F}js`, 'a', '  indented', '', '', '', 'b', F, 'first', '   second indented  '),
    fenceOtherMarkerInside: md('## Code', F, 'a', '~~~', 'b', F, 'after', '~~~', 'c', F, 'd', '~~~'),
    fenceUpperLang: md('## C', `${F}Chart`, 'A: 1', 'B: 2', F, `${F}KPI`, '1 | one', F),
    layoutHintOverInferred: md('## T', '<!-- layout: Two-Column -->', '| a | b |', '|---|---|', '| 1 | 2 |', '### L', '- a', '### R', '- b'),
    chartHintEmpty: md('## C', '<!-- chart: -->', '| m | v |', '|---|---|', '| jan | 1 |', '## D', '<!-- chart: -->', '- no table'),
    whitespaceLineInColumn: md('## W', '### L', '- a', '### R', '- b', '### ', '   '),
    coverEmptyNotes: md('# T', 'Notes:', '## A', '- a'),
    quoteBlankBetween: md('## Q', '> a', '>', '> b'),
    tableRowWithoutSeparator: md('## T', '| lone | row |', 'plain text'),
    stepsHintOverChart: md('## S', '<!-- layout: steps -->', '- one', '- two', `${F}chart`, 'A: 1', F, '## P', '<!-- layout: process -->', '- one', `${F}stats`, '1 | a', F),
    chartThenStatsWarnings: md('## W', '<!-- chart: bar -->', `${F}stats`, '1 | a | | no-such-icon', F, '### Only {icon: nope}', '- x'),
    tooLong: `## A\n${'x'.repeat(DECK_LIMITS.maxMarkdownChars)}`,
};

/** JSON decks and slide lists. @type {Record<string, unknown>} */
const JSON_DECKS = {
    slidesBasic: { title: '**Deck**', subtitle: 'sub', author: 'me', date: ' 2026-01-01 ', slides: [{ title: 'A', bullets: ['a', '  b', '- c', '1. d', '', null, 7] }, 'plain string slide\n- x', null, undefined] },
    arrayInput: [{ title: 'A', bullets: ['a'] }, { heading: 'B', points: [{ text: 'p', level: 2 }, { label: 'l' }, { title: 't', level: '1' }, {}, ['nested']] }],
    markdownField: { markdown: md('# From md', 'subtitle', '<!-- notes: cn -->', '## A', '- a') },
    markdownFieldWithTitle: { title: 'Given', subtitle: 'given sub', markdown: md('# From md', 'subtitle', '## A', '- a') },
    markdownFieldIgnored: { markdown: '## Ignored', slides: [{ title: 'Kept', body: 'b' }] },
    markdownBlank: { markdown: '   ', title: 'T' },
    emptySlidesNoTitle: { slides: [] },
    emptySlidesWithTitle: { title: 'T', slides: [{}, 5, 'x'] },
    contentSpellings: { slides: [{ title: 'c', content: '- a\n> q' }, { title: 't', text: 'text body' }, { title: 'm', markdown: '- m' }, { title: 'b', body: 'only body\nline two' },
        { title: 'cb', content: 'content', body: 'body one\nbody two' }, { title: 'tb', text: 't', body: 5 }, { title: 'i', items: ['i'] }] },
    tables: { slides: [{ title: 'matrix', table: [['a', 'b'], [1, null], 'not a row', [undefined, 'x']] }, { title: 'empty matrix', table: ['x'] },
        { title: 'object', table: { columns: ['a', { label: 'L' }, { name: 'N' }, { key: 'K' }, {}, null], rows: [[1, 2, 3, 4, 5, 6], 'skip'] } },
        { title: 'row objects', table: { columns: ['a', 'b'], rows: [{ a: 1, b: null }, { a: 'x' }] } }, { title: 'row objects no cols', table: { rows: [{ x: 1 }, { y: 2, x: 3 }] } },
        { title: 'empty object', table: {} }, { title: 'number', table: 5 }, { title: 'rows only', table: { rows: [[1.5, 'a', Infinity], [2]] } },
        { title: 'wide', table: { columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], rows: Array.from({ length: 18 }, (_, i) => [i, 'cell that is quite long indeed', i * 2]) } }] },
    quotes: { slides: [{ title: 'q', quote: 'string **quote**' }, { title: 'q2', quote: { text: 't', attribution: '_who_' } }, { title: 'q3', quote: { quote: 'alt' } }, { title: 'q4', quote: { attribution: 'only' } }, { title: 'q5', quote: 7 }] },
    images: { slides: [{ title: 's', image: KEY }, { title: 'o', image: { url: PROXY, alt: 'alt' } }, { title: 'd', image: { dataUrl: PNG, caption: 'cap' } }, { title: 'r', image: { src: REMOTE } },
        { title: 'k', image: { storageKey: KEY } }, { title: 'key', image: { key: KEY } }, { title: 'data', image: { data: PNG } }, { title: 'n', image: 5 }, { title: 'e', image: {} }, { title: 'big', image: BIG_PNG },
        { title: 'content wins', content: `![c](${KEY})` }, { title: 'explicit wins', content: `![c](${KEY})`, image: PNG }, { title: 'rs', image: REMOTE }] },
    cards: { slides: [{ title: 'cards', cards: ['string card\n- b', { title: 'T', text: 'text', icon: 'shield', image: KEY }, { heading: 'H', content: 'c', bullets: ['x'] }, { label: 'L', body: 'b', items: [], icon: 'nope', image: REMOTE }, null, 5, { title: 'seventh' }, { title: 'eighth' }] },
        { title: 'cards from md image', cards: [{ title: 'a', text: `![m](${KEY})\ntext` }, { title: 'b', text: 'b' }, { title: 'c' }] },
        { title: 'two cards', cards: [{ title: 'a', text: 'a' }, { title: 'b', text: 'b' }] }, { title: 'one card', cards: [{ title: 'a', text: 'a' }] },
        { title: 'columns as cards', columns: ['one', { title: 'two', bullets: ['x'] }, { heading: 'three', text: 't' }] }, { title: 'empty cards falls to columns', cards: [], columns: [{ title: 'l', bullets: ['a'] }, { title: 'r', bullets: ['b'] }] },
        { title: 'two as cards', layout: 'cards', columns: [{ title: 'l', bullets: ['a'] }, { title: 'r', content: 'body' }] }, { title: 'blank cards', cards: [{}, {}, {}] }] },
    columns: { slides: [{ title: 'two', columns: ['- left a\n- left b', { title: '**R**', content: 'right body\nmore' }] }, { title: 'two objects', columns: [{ heading: 'L', items: ['i'] }, { title: 'R', text: 't', bullets: ['b'] }] },
        { title: 'one', columns: [{ title: 'only', bullets: ['a'] }] }, { title: 'bad entries', columns: [null, 5] }, { title: 'empty column', columns: [{ title: 'L', bullets: ['a'] }, {}] }] },
    layouts: { slides: [{ title: 'auto', layout: 'auto', bullets: ['a'] }, { title: 'dash', layout: ' Two-Column ', bullets: ['a'] }, { title: 'closing', layout: 'closing' }, { title: 'bogus', layout: 'bogus', body: 'b' }, { title: 'num', layout: 5 },
        { title: 'timeline', layout: 'timeline', bullets: ['a — b', 'c'] }, { title: 'steps', layout: 'steps', bullets: ['a'] }, { title: 'process with steps', layout: 'process', steps: [{ title: 'given' }], bullets: ['ignored'] },
        { title: 'quote without', layout: 'quote' }, { title: 'chart without', layout: 'chart', bullets: ['x'] }, { title: 'stats without', layout: 'stats' }, { title: 'timeline without', layout: 'timeline' }] },
    notes: { slides: [{ title: 'n', notes: ' explicit ', content: '<!-- notes: parsed -->' }, { title: 's', speakerNotes: 'speaker' }, { title: 'both', notes: 'n', speakerNotes: 's' }, { title: 'num', notes: 5 }, { title: 'blank', notes: '   ' }] },
    charts: { slides: [{ title: 'type+table', chart: 'bar', table: [['m', 'v'], ['a', 1], ['b', 2]] }, { title: 'type no table', chart: 'pie' }, { title: 'type text table', chart: 'line', table: [['m', 'v'], ['a', 'x']] },
        { title: 'text', chart: 'A: 1\nB: 2' }, { title: 'spec', chart: { type: 'line', labels: ['a', 'b'], series: [{ name: 'S', values: [1, 2] }, { values: [3, 4] }], unit: '%', stacked: true, title: 'T', showValues: false } },
        { title: 'data rows', chart: { type: 'bar', data: [{ m: 'a', v: 1 }, { m: 'b', v: 2 }] } }, { title: 'empty', chart: '' }, { title: 'null', chart: null }, { title: 'no numbers', chart: { labels: ['a'], series: [{ name: 'S', values: ['x'] }] } },
        { title: 'explicit beats fence', chart: 'A: 5', content: `${F}chart\nB: 6\n${F}` }, { title: 'comma labels', chart: { labels: ['a, b', 'c'], series: [{ name: 'x: y', values: [1, null] }] } }] },
    stats: { slides: [{ title: 's', stats: [{ value: '1', label: 'one', delta: '+1', icon: 'trending-up' }, { value: '2', icon: 'no-such' }, { value: '3' }, { value: '4' }, { value: '5' }] }, { title: 'text', stats: '9 | nine\n8 | eight | -1' },
        { title: 'empty array', stats: [] }, { title: 'empty string', stats: '' }, { title: 'null', stats: null }, { title: 'explicit beats fence', stats: [{ value: 'x' }], content: `${F}stats\n1 | fence\n${F}` }] },
    steps: { slides: [{ title: 's', steps: [{ title: 'Kick-off', text: 'plan' }, 'Build', { title: 'Ship' }] }, { title: 't', timeline: ['a', 'b'] }, { title: 'empty', steps: [] }, { title: 'blank', steps: '' }, { title: 'text', steps: 'one\ntwo' },
        { title: 'both', steps: ['s'], bullets: ['b1', 'b2'] }] },
    styles: { slides: [{ title: 'a', style: 'accent', body: 'b' }, { title: 'd', style: 'DARK', body: 'b' }, { title: 'x', style: 'pink', body: 'b' }, { title: 'hint', content: '<!-- style: dark -->\nb' }, { title: 'explicit wins', style: 'accent', content: '<!-- style: dark -->\nb' }] },
    hintPriority: { slides: [{ title: 'explicit over comment', layout: 'section', content: '<!-- layout: closing -->\n- a' }, { title: 'empty steps', layout: 'timeline', steps: [], bullets: ['a', 'b'] },
        { title: 'cards by comment', content: '<!-- layout: cards -->', columns: [{ title: 'l', bullets: ['a'] }, { title: 'r', bullets: ['b'] }] }] },
    precedence: { slides: [{ title: 'content first', content: 'c', text: 't', markdown: 'm', body: 'b' }, { title: 'text before markdown', text: 't', markdown: 'm' },
        { title: 'card text first', cards: [{ title: 'a', text: 't', content: 'c', body: 'b' }, { title: 'b', content: 'c', body: 'b' }, { title: 'explicit image first', text: `![m](${KEY})`, image: PNG }] },
        { title: 'pair content first', columns: [{ title: 'l', content: '- from content', text: '- from text' }, { title: 'r', text: '- only text' }] },
        { title: 'hyphen layout', layout: 'two-column', table: [['a'], [1]], columns: [{ title: 'l', bullets: ['a'] }, { title: 'r', bullets: ['b'] }] },
        { title: 'padded layout', layout: ' Cards ', columns: [{ title: 'l', bullets: ['a'] }, { title: 'r', bullets: ['b'] }] },
        { title: 'auto yields to the comment', layout: 'auto', content: '<!-- layout: closing -->\n- a' }, { title: 'notes not text', speakerNotes: 5, body: 'b' },
        { title: 'warning order', image: REMOTE, cards: [{ title: 'a', image: `${REMOTE}?card` }, { title: 'b', icon: 'nope' }, { title: 'c' }], chart: 'pie', stats: [{ value: '1', icon: 'no-such' }], steps: Array.from({ length: 8 }, (_, i) => `s${i}`) },
        { title: 'empty tiles yield to the block', stats: [], content: `${F}stats\n1 | fence\n${F}` }, { title: 'steps before timeline', steps: ['from steps'], timeline: ['from timeline'] }] },
    clampEdges: { slides: [{ title: 'no width', table: { rows: [[]] } }, { title: 'table then image', table: { columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], rows: Array.from({ length: 16 }, () => [1]) }, image: BIG_PNG }] },
    titles: { slides: [{ heading: 'h' }, { title: 'x'.repeat(200) }, { title: '', body: 'no title' }, { title: 5, bullets: ['n'] }] },
    tooManySlides: { title: 'T', slides: Array.from({ length: 61 }, (_, i) => ({ title: `s${i}` })) },
    overflow: { slides: [{ title: 'Many', bullets: Array.from({ length: 25 }, (_, i) => `b${i}`), body: 'body', table: [['a'], [1]], image: KEY, quote: 'q', chart: 'A: 1', stats: [{ value: '1' }], steps: ['s'], notes: 'n', style: 'accent' }] },
    cardsLong: { slides: [{ title: 'c', cards: [{ title: 't'.repeat(200), text: 'x '.repeat(300) }, { title: 'b', text: 'b' }, { text: 'no title' }] }] },
    everything: { title: 'All', slides: [{ title: 'Mixed', style: 'dark', body: 'body', image: { url: KEY, alt: 'the | alt' }, table: { columns: ['a|b', 'c'], rows: [['1|2', null]] },
        chart: { type: 'donut', labels: ['A', 'B'], series: [{ name: 'S', values: [60, 40] }] }, stats: [{ value: '1', label: 'one' }], bullets: ['b'], quote: { text: 'q\nline', attribution: 'w' }, notes: 'has --> inside\nand a line' }] },
};

/** Inputs normalizeDeck refuses. @type {Record<string, unknown>} */
const INVALID = { nullInput: null, number: 5, objectWithoutSlides: { title: 'T' }, emptyString: '', markdownNotString: { markdown: 5 }, slidesNotArray: { slides: 'x' } };

/**
 * Slides as no parser produces them, straight into the clamp: what it drops,
 * cuts and re-infers on its own. A function, so every run clamps fresh objects.
 */
const rawDecks = () => ({
    bullets: { title: 'T', slides: [{ title: 'b', bullets: [{ text: '', level: 0 }, { text: 'kept', level: 5 }, { text: 'plain' }], layout: 'bullets' }] },
    cards: { title: 'T', slides: [
        { title: 'eight', layout: 'cards', bullets: [], cards: Array.from({ length: 8 }, (_, i) => ({ title: `c${i}`, text: 't', icon: i ? 'shield' : '', image: null })) },
        { title: 'holes', layout: 'cards', bullets: [], cards: [{ title: '', text: '', image: null }, { title: '', text: '', image: { storageKey: KEY, alt: '' } }, { title: 'x' }] },
        { title: 'one left', layout: 'cards', bullets: [], cards: [{ title: 'only' }, {}] },
    ] },
    columns: { title: 'T', slides: [
        { title: 'empty one', layout: 'two_column', bullets: [], columns: [{ title: null, bullets: [] }, { title: 'r', bullets: [{ text: 'b', level: 3 }] }] },
        { title: 'both kinds', layout: 'cards', bullets: [], cards: [{ title: 'card title '.repeat(20) }, { title: 'b' }], columns: [{ title: 'column title '.repeat(20), bullets: [{ text: 'bullet '.repeat(60) }] }, { title: 'r', bullets: [] }] },
    ] },
    visuals: { title: 'T', slides: [
        { title: 'no numbers', layout: 'chart', bullets: [], chart: { type: 'bar', labels: ['a'], series: [{ name: 's', values: ['x', null] }] } },
        { title: 'no series', layout: 'chart', bullets: [], chart: { type: 'bar' } },
        { title: 'numbers', layout: 'chart', bullets: [], chart: { type: 'bar', labels: ['a'], series: [{ name: 's', values: [null, 2] }] } },
        { title: 'empty tiles', layout: 'stats', bullets: [], stats: [] }, { title: 'empty steps', layout: 'timeline', bullets: [], steps: [] },
        { title: 'style', layout: 'section', bullets: [], style: ' ACCENT ' }, { title: 'bad style', bullets: [{ text: 'x' }], style: 'pink', layout: 'nonsense' },
        { title: 'no layout', bullets: [{ text: 'x' }] }, { title: 'kept layout', layout: 'closing', bullets: [{ text: 'x' }] },
    ] },
    tables: { title: 'T', slides: [{ title: 'no columns', layout: 'table', bullets: [], table: { columns: [], rows: [[1, 'two', null, undefined, NaN], [3]] } }, { title: 'nothing', layout: 'table', bullets: [], table: { columns: [], rows: [] } }] },
    empty: { title: '', slides: [{ title: '', bullets: [] }] },
    deckTexts: { title: 'Deck title '.repeat(20), subtitle: 'sub '.repeat(80), author: 'author '.repeat(30), coverNotes: 'note '.repeat(900), slides: [{ title: 'a', bullets: [] }] },
});

/** @param {() => unknown} fn */
function attempt(fn) {
    try { return fn(); }
    catch (e) { const err = /** @type {Error & { errorClass?: string }} */ (e); return { error: { name: err.name, errorClass: err.errorClass, message: err.message } }; }
}

/**
 * @param {unknown} input
 * @param {typeof DECK_LIMITS} limits
 */
function deckRecord(input, limits) {
    return attempt(() => {
        const deck = normalizeDeck(/** @type {string | object} */ (input), { limits });
        return { deck, normalized: /** @type {{ normalized?: boolean }} */ (deck).normalized === true, markdown: deckToMarkdown(deck) };
    });
}

function record() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, input] of Object.entries({ ...MARKDOWN, ...Object.fromEntries(Object.entries(JSON_DECKS).map(([k, v]) => [`json:${k}`, v])), ...Object.fromEntries(Object.entries(INVALID).map(([k, v]) => [`invalid:${k}`, v])) })) {
        out[name] = { default: deckRecord(input, DECK_LIMITS), tight: deckRecord(input, TIGHT) };
    }
    // The single-slide entry, over every JSON slide above.
    for (const [name, deck] of Object.entries(JSON_DECKS)) {
        const slides = Array.isArray(deck) ? deck : /** @type {{ slides?: unknown[] }} */ (deck).slides || [];
        out[`slide:${name}`] = slides.slice(0, 30).map((s) => ({ default: attempt(() => normalizeSlide(s)), tight: attempt(() => normalizeSlide(s, { limits: TIGHT })) }));
    }
    for (const name of Object.keys(rawDecks())) {
        out[`clamp:${name}`] = [DECK_LIMITS, TIGHT].map((limits) => attempt(() => { /** @type {string[]} */ const warnings = []; return { deck: clampDeck(/** @type {Record<string, unknown>} */ (rawDecks())[name], limits, warnings), warnings }; }));
    }
    // deckToMarkdown normalises a raw deck itself.
    out['raw:toMarkdown'] = [attempt(() => deckToMarkdown(JSON_DECKS.everything)), attempt(() => deckToMarkdown(MARKDOWN.twoAsCards)), attempt(() => deckToMarkdown(null))];
    return JSON.parse(JSON.stringify(out));
}

test('deck model: every input gives the recorded deck, warnings and outline', () => {
    const actual = record();
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(golden)) assert.deepEqual(actual[name], golden[name], name);
});

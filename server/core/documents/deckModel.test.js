/**
 * The deck model is the contract every presentation surface shares, so what
 * is pinned here is the GRAMMAR (what a markdown outline / a JSON deck turns
 * into) and the CAPS (what gets shortened, split or refused) — not rendering.
 *
 * Run: node --test --test-force-exit core/documents/deckModel.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    normalizeDeck, normalizeSlide, DECK_LIMITS, DECK_INPUT_PROPERTIES, SLIDE_LAYOUTS, DeckError, classifyImageRef,
} = require('./deckModel');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const MD = `# Kwartaalcijfers Q3

Een korte inleiding voor de bank.

Nog een alinea die op de intro-slide hoort.

## Omzet

- Omzet steeg **12%**
  - vooral in DE
- Marge stabiel

<!-- notes: Benadruk de DE-groei -->

## Cijfers

| Regel | 2025 |
|---|---|
| Omzet | 25.367 |

## Quote

> Wij groeien door.
> — CEO

## Twee kolommen

### Links
- a
- b
### Rechts
- c

## Afbeelding

![logo](https://example.com/x.png)

Notes: dit zijn notities
`;

test('markdown: the h1 is the cover, the first paragraph the subtitle, the rest an intro slide', () => {
    const d = normalizeDeck(MD);
    assert.strictEqual(d.title, 'Kwartaalcijfers Q3');
    assert.strictEqual(d.subtitle, 'Een korte inleiding voor de bank.');
    assert.strictEqual(d.slides[0].title, 'Kwartaalcijfers Q3');
    assert.match(d.slides[0].body, /intro-slide/);
});

test('markdown: every h2 is one slide, bullets keep one level of nesting, inline markdown is stripped', () => {
    const d = normalizeDeck(MD);
    const omzet = d.slides[1];
    assert.strictEqual(omzet.title, 'Omzet');
    assert.strictEqual(omzet.layout, 'bullets');
    assert.deepStrictEqual(omzet.bullets, [
        { text: 'Omzet steeg 12%', level: 0 },
        { text: 'vooral in DE', level: 1 },
        { text: 'Marge stabiel', level: 0 },
    ]);
    assert.strictEqual(omzet.notes, 'Benadruk de DE-groei');
});

test('markdown: a GFM table, a quote with attribution and two ### columns get their layouts', () => {
    const d = normalizeDeck(MD);
    const [, , cijfers, quote, cols] = d.slides;
    assert.strictEqual(cijfers.layout, 'table');
    assert.deepStrictEqual(cijfers.table, { columns: ['Regel', '2025'], rows: [['Omzet', '25.367']] });
    assert.strictEqual(quote.layout, 'quote');
    assert.deepStrictEqual(quote.quote, { text: 'Wij groeien door.', attribution: 'CEO' });
    assert.strictEqual(cols.layout, 'two_column');
    assert.deepStrictEqual(cols.columns.map((c) => c.title), ['Links', 'Rechts']);
    assert.strictEqual(cols.columns[0].bullets.length, 2);
});

test('markdown: a remote image is dropped with a warning and never kept; a trailing Notes: paragraph is notes', () => {
    const d = normalizeDeck(MD);
    const img = d.slides[5];
    assert.strictEqual(img.image, null);
    assert.strictEqual(img.layout, 'section');
    assert.strictEqual(img.notes, 'dit zijn notities');
    assert.ok(d.warnings.some((w) => /example\.com/.test(w) && /skipped/.test(w)));
});

test('markdown: a data: image and a storage proxy URL are kept as references', () => {
    const d = normalizeDeck(`# T\n\n## A\n\n![a](${PNG})\n\n## B\n\n![b](/api/storage/file/users/u1/images/pic%20one.png)`);
    assert.strictEqual(d.slides[0].layout, 'image');
    assert.strictEqual(d.slides[0].image.dataUrl, PNG);
    assert.deepStrictEqual(d.slides[1].image, { storageKey: 'users/u1/images/pic one.png', alt: 'b' });
});

test('markdown: <!-- layout --> forces a layout, --- breaks a slide, a second h1 is a slide', () => {
    const d = normalizeDeck('# T\n\n## A\n<!-- layout: section -->\n- x\n\n---\n\nloose text\n\n# Also a slide\n- y');
    assert.strictEqual(d.slides[0].layout, 'section');
    assert.strictEqual(d.slides[1].title, '');
    assert.strictEqual(d.slides[1].body, 'loose text');
    assert.strictEqual(d.slides[2].title, 'Also a slide');
});

test('json: bullets as strings (two-space indent = sub-point) or objects, table from objects, content parsed as markdown', () => {
    const d = normalizeDeck({ title: 'T', slides: [
        { title: 'A', bullets: ['x', '  y', { text: 'z', level: 1 }] },
        { title: 'B', content: '- p\n- q\n\nNotes: n' },
        { title: 'tab', table: { columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] } },
        'loose text',
    ] });
    assert.deepStrictEqual(d.slides[0].bullets.map((b) => b.level), [0, 1, 1]);
    assert.strictEqual(d.slides[1].bullets.length, 2);
    assert.strictEqual(d.slides[1].notes, 'n');
    assert.deepStrictEqual(d.slides[2].table, { columns: ['a', 'b'], rows: [[1, 2]] });
    assert.strictEqual(d.slides[3].body, 'loose text');
});

test('json: layout is inferred from content and an explicit layout wins only when the content supports it', () => {
    const d = normalizeDeck({ title: 'T', slides: [
        { title: 'only a title' },
        { title: 'q', quote: 'said' },
        { title: 'forced', layout: 'closing', body: 'bye' },
        { title: 'bogus', layout: 'table', bullets: ['no table here'] },
        { title: 'img', image: { url: 'https://evil.example/x.png' } },
    ] });
    assert.deepStrictEqual(d.slides.map((s) => s.layout), ['section', 'quote', 'closing', 'bullets', 'section']);
    assert.ok(d.warnings.some((w) => /evil\.example/.test(w)));
});

test('caps: long text is shortened with a warning, an overfull bullet list becomes continuation slides', () => {
    const long = 'x'.repeat(DECK_LIMITS.maxBulletChars + 50);
    const d = normalizeDeck({ title: 'T', slides: [
        { title: 'Many', bullets: Array.from({ length: 23 }, (_, i) => `b${i}`) },
        { title: 'Long', bullets: [long] },
    ] });
    assert.deepStrictEqual(d.slides.map((s) => s.title), ['Many', 'Many (2)', 'Many (3)', 'Long']);
    assert.strictEqual(d.slides[0].bullets.length, DECK_LIMITS.maxBulletsPerSlide);
    assert.strictEqual(d.slides[2].bullets.length, 3);
    assert.strictEqual(d.slides[3].bullets[0].text.length, DECK_LIMITS.maxBulletChars);
    assert.ok(d.warnings.some((w) => /split over 3 slides/.test(w)));
    assert.ok(d.warnings.some((w) => /shortened/.test(w)));
});

test('caps: a table is cut to the column/row limits and an oversized data: image is dropped', () => {
    const wide = Array.from({ length: DECK_LIMITS.maxTableCols + 3 }, (_, i) => `c${i}`);
    const big = `data:image/png;base64,${'A'.repeat(Math.ceil(DECK_LIMITS.maxImageBytes * 4 / 3) + 400)}`;
    const d = normalizeDeck({ title: 'T', slides: [
        { title: 'wide', table: { columns: wide, rows: Array.from({ length: 30 }, () => wide) } },
        { title: 'big', image: { dataUrl: big } },
    ] });
    assert.strictEqual(d.slides[0].table.columns.length, DECK_LIMITS.maxTableCols);
    assert.strictEqual(d.slides[0].table.rows.length, DECK_LIMITS.maxTableRows);
    assert.strictEqual(d.slides[1].image, null);
    assert.ok(d.warnings.some((w) => /larger than/.test(w)));
});

test('refusals: an empty outline, a deck past the slide cap, and garbage', () => {
    assert.throws(() => normalizeDeck('   '), (e) => e instanceof DeckError && e.errorClass === 'deck_empty');
    assert.throws(() => normalizeDeck({ slides: [] }), (e) => e.errorClass === 'deck_empty');
    assert.throws(
        () => normalizeDeck({ slides: Array.from({ length: DECK_LIMITS.maxSlides + 1 }, (_, i) => ({ title: `s${i}` })) }),
        (e) => e.errorClass === 'deck_too_large',
    );
    assert.throws(() => normalizeDeck(42), (e) => e.errorClass === 'deck_invalid');
});

test('empty slides vanish; a deck with only a title is a cover', () => {
    const d = normalizeDeck({ title: 'Only', slides: [{}, { title: '' }] });
    assert.strictEqual(d.slides.length, 0);
    assert.strictEqual(d.title, 'Only');
});

test('a normalised deck is flagged so renderers can skip a second pass', () => {
    const d = normalizeDeck({ title: 'T', slides: [{ title: 'a' }] });
    assert.strictEqual(d.normalized, true);
    assert.ok(!Object.keys(d).includes('normalized'), 'not enumerable — never serialised into a step output');
});

test('normalizeSlide gives one clamped slide for the automation slide step', () => {
    const { slide, warnings } = normalizeSlide({ title: 'S', content: '- one\n- two', layout: 'auto', notes: 'n' });
    assert.strictEqual(slide.layout, 'bullets');
    assert.strictEqual(slide.bullets.length, 2);
    assert.strictEqual(slide.notes, 'n');
    assert.deepStrictEqual(warnings, []);
});

test('classifyImageRef: data:, proxy URL, bare key, and everything else', () => {
    assert.ok(classifyImageRef(PNG).dataUrl);
    assert.strictEqual(classifyImageRef('/api/storage/file/users/u/images/a.png').storageKey, 'users/u/images/a.png');
    assert.strictEqual(classifyImageRef('https://bf.example/api/storage/file/users/u/images/a.png').storageKey, 'users/u/images/a.png');
    assert.strictEqual(classifyImageRef('users/u/images/a.png').storageKey, 'users/u/images/a.png');
    assert.strictEqual(classifyImageRef('users/u/../v/images/a.png').rejected, 'users/u/../v/images/a.png');
    assert.strictEqual(classifyImageRef('https://example.com/a.png').rejected, 'https://example.com/a.png');
    assert.strictEqual(classifyImageRef(''), null);
});

test('the tool-schema fragment names the four deck inputs and the closed layout list', () => {
    assert.deepStrictEqual(Object.keys(DECK_INPUT_PROPERTIES), ['title', 'subtitle', 'slides', 'markdown']);
    assert.deepStrictEqual(DECK_INPUT_PROPERTIES.slides.items.properties.layout.enum, [...SLIDE_LAYOUTS]);
});

// ── visuals (round 3) ───────────────────────────────────────────────────

test('markdown visuals: a ```chart block, "<!-- chart -->" over a table, a ```stats block, a timeline and a style comment', () => {
    const d = normalizeDeck([
        '# Kwartaal',
        '## Omzet', '```chart', 'type: bar', 'labels: Q1, Q2', 'Omzet: 10, 20', 'Kosten: 5, 8', '```', '- groei',
        '## Regio', '<!-- chart: pie -->', '| Regio | Omzet |', '|---|---|', '| Noord | € 1.554,25 |', '| Zuid | 2.795 |',
        '## Cijfers', '```stats', '€ 1,2M | Omzet | +12%', '48 | Klanten', '```',
        '## Plan', '<!-- layout: timeline -->', '<!-- style: accent -->', '- Kick-off — start', '- Live',
        '## Rijen', '```chart', '[{"maand":"jan","omzet":12},{"maand":"feb","omzet":15}]', '```',
        '## Code', '```js', 'const x = 1;', '```',
    ].join('\n'));
    const [omzet, regio, cijfers, plan, rijen, code] = d.slides;
    assert.strictEqual(omzet.layout, 'chart');
    assert.strictEqual(omzet.chart.type, 'bar');
    assert.deepStrictEqual(omzet.chart.series.map((s) => s.name), ['Omzet', 'Kosten']);
    assert.strictEqual(omzet.bullets.length, 1, 'text beside the chart survives');
    assert.strictEqual(regio.layout, 'chart');
    assert.strictEqual(regio.chart.type, 'pie');
    assert.strictEqual(regio.table, null, 'the table became the chart');
    assert.deepStrictEqual(regio.chart.series[0].values, [1554.25, 2795]);
    assert.strictEqual(cijfers.layout, 'stats');
    assert.strictEqual(cijfers.stats.length, 2);
    assert.strictEqual(plan.layout, 'timeline');
    assert.strictEqual(plan.style, 'accent');
    assert.deepStrictEqual(plan.steps[0], { title: 'Kick-off', text: 'start' });
    assert.strictEqual(rijen.layout, 'chart');
    assert.deepStrictEqual(rijen.chart.labels, ['jan', 'feb']);
    assert.strictEqual(code.layout, 'bullets');
    assert.match(code.body, /const x = 1;/, 'a code fence is prose, not a visual');
    assert.deepStrictEqual(d.warnings, []);
});

test('JSON visuals: chart wrappers with data + columns, a bare type charts the table, stats/steps/style fields, and invalid ones degrade', () => {
    const d = normalizeDeck({ slides: [
        { title: 'x', chart: { type: 'line', data: [{ m: 'a', v: '1,5' }, { m: 'b', v: 2 }], labels: 'm' } },
        { title: 't', table: { columns: ['a', 'b'], rows: [['x', 1]] }, chart: 'donut' },
        { title: 's', stats: '10 | a\n20 | b', style: 'DARK' },
        { title: 'p', steps: [{ title: 'A', text: 'b' }] },
        { title: 'bad', chart: { type: 'bar', data: [{ a: 'x' }] }, bullets: ['keep'] },
        { title: 'lay', layout: 'chart', bullets: ['no chart here'] },
        { title: 'style?', style: 'neon', bullets: ['a'] },
    ] });
    const [x, t, s, p, bad, lay, st] = d.slides;
    assert.strictEqual(x.chart.type, 'line');
    assert.deepStrictEqual(x.chart.series, [{ name: 'v', values: [1.5, 2] }]);
    assert.strictEqual(t.layout, 'chart');
    assert.strictEqual(t.chart.type, 'donut');
    assert.strictEqual(t.table, null);
    assert.strictEqual(s.layout, 'stats');
    assert.strictEqual(s.style, 'dark');
    assert.strictEqual(p.layout, 'timeline');
    assert.strictEqual(bad.chart, null);
    assert.strictEqual(bad.layout, 'bullets');
    assert.strictEqual(lay.layout, 'bullets', 'a layout naming a missing visual is re-inferred');
    assert.strictEqual(st.style, null);
    assert.ok(d.warnings.some((w) => /no numbers/.test(w)));
});

test('the slide schema and the layout list name the visuals; a continuation slide never repeats a visual', () => {
    assert.ok(['chart', 'stats', 'timeline'].every((l) => SLIDE_LAYOUTS.includes(l)));
    for (const k of ['chart', 'stats', 'steps', 'style']) assert.ok(DECK_INPUT_PROPERTIES.slides.items.properties[k], `${k} in SLIDE_INPUT_SCHEMA`);
    assert.match(DECK_INPUT_PROPERTIES.markdown.description, /```chart/);
    const d = normalizeDeck({ slides: [{ title: 'big', chart: { labels: ['a'], series: [{ name: 's', values: [1] }] }, bullets: Array.from({ length: 12 }, (_, i) => `b${i}`) }] });
    assert.strictEqual(d.slides.length, 2);
    assert.ok(d.slides[0].chart);
    assert.strictEqual(d.slides[1].chart, null);
});

test('cards: three to six "###" blocks (or a `cards` list) become titled cards; two stay columns unless the layout says cards', () => {
    const d = normalizeDeck(['# T',
        '## Three', 'Lead.', '### A', 'a text', '### B', '- b1', '- b2', '### C', 'c',
        '## Two', '### L', '- l', '### R', '- r',
        '## Five', '### 1', 'x', '### 2', 'x', '### 3', 'x', '### 4', 'x', '### 5', 'x',
    ].join('\n'));
    const [three, two, five] = d.slides;
    assert.strictEqual(three.layout, 'cards');
    assert.deepStrictEqual(three.cards, [{ title: 'A', text: 'a text', icon: null, image: null }, { title: 'B', text: 'b1\nb2', icon: null, image: null }, { title: 'C', text: 'c', icon: null, image: null }]);
    assert.strictEqual(three.body, 'Lead.');
    assert.strictEqual(two.layout, 'two_column');
    assert.strictEqual(five.layout, 'cards', 'up to six cards');
    assert.strictEqual(five.cards.length, 5);
    const j = normalizeDeck({ slides: [{ title: 'j', cards: [{ title: 'a', text: '1' }, { title: 'b', text: '2' }, { title: 'c', text: '3' }, { title: 'd', text: '4' }] }, { title: 'k', columns: [{ title: 'a', text: '1' }, { title: 'b', text: '2' }, { title: 'c', text: '3' }] }] });
    assert.strictEqual(j.slides[0].cards.length, 4);
    assert.strictEqual(j.slides[1].layout, 'cards', 'three columns are cards');
    assert.ok(DECK_INPUT_PROPERTIES.slides.items.properties.cards);
});

test('cards carry an icon ({icon: name} in the heading, Lucide names with aliases) and a picture from an image line inside the block; tiles carry an icon too', () => {
    const d = normalizeDeck(['# T', '## Why',
        '### Wi-Fi off {icon: wifi-off}', 'All local.',
        '### Tools {icon: tools}', '![](users/u1/images/x.png)', 'List files.',
        '### Guardrails {icon: nope}', 'Caught.',
        '## Pair', '<!-- layout: cards -->', '### A', 'a', '### B', 'b',
        '## KPI', '```stats', '2m | Processing | -95% | clock', '```',
    ].join('\n'));
    const [why, pair, kpi] = d.slides;
    assert.strictEqual(why.layout, 'cards');
    assert.strictEqual(why.cards[0].icon, 'wifi-off');
    assert.strictEqual(why.cards[1].icon, 'wrench', 'an alias resolves');
    assert.strictEqual(why.cards[1].image.storageKey, 'users/u1/images/x.png');
    assert.strictEqual(why.cards[1].title, 'Tools', 'the tag is not part of the title');
    assert.strictEqual(why.cards[2].icon, null);
    assert.ok(d.warnings.some((w) => /unknown icon "nope"/.test(w)));
    assert.strictEqual(pair.layout, 'cards', 'two ### blocks are cards when asked');
    assert.strictEqual(kpi.stats[0].icon, 'clock');
    const j = normalizeDeck({ slides: [{ title: 'j', cards: [{ title: 'a', text: '1', icon: 'shield' }, { title: 'b', text: '2', image: { url: 'users/u1/images/b.png' } }, { title: 'c', text: '3' }] }] });
    assert.strictEqual(j.slides[0].cards[0].icon, 'shield');
    assert.strictEqual(j.slides[0].cards[1].image.storageKey, 'users/u1/images/b.png');
});

test('deckToMarkdown: the outline of a normalised deck round-trips — layouts, visuals, cards, notes, styles — and is stable', () => {
    const { deckToMarkdown } = require('./deckModel');
    const md = [
        '# Airplane Mode', '', 'AI that automates Nextcloud', '', '<!-- notes: cover notes -->', '',
        '## Who we are', '<!-- layout: cards -->', '### Tom {icon: user}', 'Co-founder.', '### Bee Flow {icon: layout-grid}', 'AI workspace.', 'Notes: hello',
        '## Numbers', '```chart', 'type: line', 'unit: %', 'labels: Q1, Q2', 'Omzet: 10, 20', 'Kosten: 5, 8', '```', 'Some body',
        '## KPIs', '```stats', '€ 1,2M | Omzet | +12% | users', '48 | Klanten', '```',
        '## Steps', '<!-- layout: timeline -->', '- Kick-off — scope', '- Build: sprints', '- Live',
        '## Quote', '> Something wise', '> — Someone',
        '## Table', '| A | B |', '|---|---|', '| x | 1 |',
        '## Cols', '### Left', '- a', '### Right', '- b',
        '## Three', '### One {icon: shield}', 'Text one', '### Two', 'Text two', '### Three', 'Text three',
        '## Picture', '![A logo](users/u1/images/logo.png)',
        '## Emphasis', '<!-- style: accent -->', 'Just text', '- bullet', '  - sub',
        '## Thanks', '<!-- layout: closing -->', 'Come and build with us.',
    ].join('\n');
    const first = normalizeDeck(md);
    const out = deckToMarkdown(first);
    const again = normalizeDeck(out);
    const strip = (d) => JSON.parse(JSON.stringify({ title: d.title, subtitle: d.subtitle, coverNotes: d.coverNotes, slides: d.slides }));
    assert.deepStrictEqual(strip(again), strip(first));
    assert.deepStrictEqual(again.warnings, []);
    assert.strictEqual(deckToMarkdown(again), out, 'serialising twice gives the same text');
    // What the text says, for a person who reads it.
    assert.match(out, /^# Airplane Mode\n\nAI that automates Nextcloud\n/);
    assert.match(out, /## Who we are\n<!-- layout: cards -->\n### Tom \{icon: user\}\nCo-founder\./);
    assert.match(out, /```chart\ntype: line\nunit: %\nlabels: Q1, Q2\nOmzet: 10, 20\nKosten: 5, 8\n```/);
    assert.match(out, /```stats\n€ 1,2M \| Omzet \| \+12% \| users\n48 \| Klanten\n```/);
    assert.match(out, /## Steps\n<!-- layout: timeline -->\n- Kick-off — scope\n- Build: sprints\n- Live/, 'the bullets are written as they were; the steps are read from them again');
    assert.match(out, /!\[A logo\]\(users\/u1\/images\/logo\.png\)/, 'a storage reference stays a reference');
    assert.doesNotMatch(out, /<!-- layout: bullets -->/, 'inferred layouts are not spelled out');
    // A deck that arrived as JSON becomes editable text too.
    const json = deckToMarkdown({ title: 'J', slides: [{ title: 'S', bullets: ['a', '  b'], notes: 'n', style: 'dark' }, { title: 'T', table: { columns: ['k', 'v'], rows: [['x', '1']] } }] });
    assert.match(json, /## S\n<!-- style: dark -->\n- a\n  - b\n<!-- notes: n -->/);
    assert.match(json, /## T\n\| k \| v \|\n\| --- \| --- \|\n\| x \| 1 \|/);
});

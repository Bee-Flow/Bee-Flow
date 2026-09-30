/**
 * projects/comments/passage.js — finding a comment's quote in the Markdown of
 * the item it is anchored to, the section around it, and reading the item.
 *
 * Proven:
 *   - a quote is found through inline Markdown (bold, links, list markers,
 *     line breaks), then without case, and a repeated quote is told apart by
 *     its prefix;
 *   - the section runs from the nearest heading above to the next heading of
 *     the same or a higher level, and a long one is windowed around the quote;
 *   - a quote that is gone is reported as not found; a whole-item comment gets
 *     the beginning of the item;
 *   - the reader returns Markdown for notebooks and documents only while the
 *     item is filed in the project, prefers the live co-editing text, and
 *     finds a designed document's section by its id.
 *
 * Run: cd server && node --test projects/comments/passage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { findPassage, visibleText, sectionHtmlOf, makeItemReader, SECTION_CHARS } = require('./passage');

const MD = [
    '# Plan',
    '',
    'Intro text.',
    '',
    '## Budget',
    '',
    'We agreed **the budget** is [40k](https://example.test) for Q3.',
    '- Travel is *not* included',
    '',
    '### Detail',
    'The budget is revisited in May.',
    '',
    '## Timeline',
    'Launch in June.',
].join('\n');

test('the visible text of a Markdown line', () => {
    assert.strictEqual(visibleText('## A **bold** [link](x) and `code`'), 'A bold link and code');
    assert.strictEqual(visibleText('- [x] done item'), 'done item');
    assert.strictEqual(visibleText('> quoted \\*star\\*'), 'quoted star');
    assert.strictEqual(visibleText('| a | b |'), 'a b');
});

test('a quote is found through inline Markdown and the section is bounded by headings', () => {
    const p = findPassage(MD, { quote: 'the budget is 40k for Q3. Travel is not', prefix: 'We agreed ' });
    assert.strictEqual(p.found, true);
    assert.strictEqual(p.whole, false);
    assert.strictEqual(p.heading, 'Budget');
    assert.ok(p.section.startsWith('## Budget'));
    assert.ok(p.section.includes('### Detail'), 'a deeper heading stays inside the section');
    assert.ok(!p.section.includes('Timeline'), 'the next heading of the same level ends it');
    assert.ok(!p.section.includes('Intro'));
});

test('case is ignored when needed, and a repeated quote is told apart by its prefix', () => {
    const insensitive = findPassage(MD, { quote: 'LAUNCH IN JUNE' });
    assert.strictEqual(insensitive.found, true);
    assert.strictEqual(insensitive.heading, 'Timeline');

    const twice = ['# One', 'Alpha says hello.', '# Two', 'Beta says hello.'].join('\n');
    assert.strictEqual(findPassage(twice, { quote: 'says hello', prefix: 'Beta ' }).heading, 'Two');
    assert.strictEqual(findPassage(twice, { quote: 'says hello', prefix: 'Alpha ' }).heading, 'One');
    assert.strictEqual(findPassage(twice, { quote: 'says hello' }).heading, 'One', 'no prefix: the first one');
});

test('a quote without a heading above it gets the text up to the first heading', () => {
    const md = ['Opening words here.', 'More opening.', '# Later', 'Other.'].join('\n');
    const p = findPassage(md, { quote: 'More opening' });
    assert.strictEqual(p.found, true);
    assert.strictEqual(p.heading, '');
    assert.strictEqual(p.section, 'Opening words here.\nMore opening.');
});

test('a quote that is gone is reported, and a whole-item comment gets the beginning', () => {
    const gone = findPassage(MD, { quote: 'a sentence nobody wrote' });
    assert.deepStrictEqual(gone, { found: false, whole: false, quote: 'a sentence nobody wrote', heading: '', section: '' });
    const whole = findPassage(MD, null);
    assert.strictEqual(whole.whole, true);
    assert.ok(whole.section.startsWith('# Plan'));
    assert.strictEqual(findPassage('', { quote: 'x' }).found, false);
});

test('a long section is windowed around the quote', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Line ${i} with some filler text.`).join('\n');
    const md = `# Big\n${filler}\nThe needle sits here.\n${filler}`;
    const p = findPassage(md, { quote: 'The needle sits here.' });
    assert.strictEqual(p.found, true);
    assert.ok(p.section.length <= SECTION_CHARS + 4);
    assert.ok(p.section.includes('The needle sits here.'), 'the window keeps the quote');
    assert.ok(p.section.startsWith('… ') && p.section.endsWith(' …'));
});

// ── Reading the item ──────────────────────────────────────────────────────

const { JSDOM } = require('jsdom');
const domParser = () => new JSDOM('').window.DOMParser;

function reader(overrides = {}) {
    return makeItemReader({
        getNotebook: async (id, userId) => (id === 'nb1' && userId === 'ann'
            ? { id, name: 'Research', projectId: 'p1', documentMd: '# Notes\nHello', documentContent: '<h1>Notes</h1>' } : null),
        getDocument: async (id, ctx) => (id === 'doc1' && ctx.userId === 'ann'
            ? { id, name: 'Proposal', projectId: 'p1', bodyHtml: '<section data-doc-section="pricing"><h2>Pricing</h2><p>40k</p></section><p>Rest</p>' } : null),
        htmlToMarkdown: (html) => `MD(${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()})`,
        collab: () => null,
        domParser,
        ...overrides,
    });
}

test('the reader returns Markdown only for an item filed in the project and readable by the member', async () => {
    const r = reader();
    assert.deepStrictEqual(await r.read({ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'ann' }),
        { name: 'Research', markdown: '# Notes\nHello', sectionMarkdown: '' });
    assert.strictEqual(await r.read({ projectId: 'p2', targetType: 'notebook', targetId: 'nb1', userId: 'ann' }), null, 'another project');
    assert.strictEqual(await r.read({ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'bob' }), null, 'not readable by bob');
    assert.strictEqual(await r.read({ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: null }), null, 'no reader, no read');
    assert.strictEqual(await r.read({ projectId: 'p1', targetType: 'meeting', targetId: 'nb1', userId: 'ann' }), null);

    const doc = await r.read({ projectId: 'p1', targetType: 'document', targetId: 'doc1', userId: 'ann', sectionId: 'pricing' });
    assert.strictEqual(doc.name, 'Proposal');
    assert.strictEqual(doc.markdown, 'MD(Pricing 40k Rest)');
    assert.strictEqual(doc.sectionMarkdown, 'MD(Pricing 40k)', 'the designed section by its id');
});

test('the reader builds its DOMParser once, not a browser window per read', async () => {
    let made = 0;
    const r = reader({ domParser: () => { made += 1; return domParser(); } });
    for (let i = 0; i < 3; i++) {
        const doc = await r.read({ projectId: 'p1', targetType: 'document', targetId: 'doc1', userId: 'ann', sectionId: 'pricing' });
        assert.strictEqual(doc.sectionMarkdown, 'MD(Pricing 40k)');
    }
    assert.strictEqual(made, 1);
});

test('the reader prefers the live co-editing text and falls back when it fails', async () => {
    const calls = [];
    const live = reader({
        collab: () => ({
            isActive: async (kind, id) => { calls.push([kind, id]); return true; },
            readMarkdown: async () => '# Live\nFresh words',
        }),
    });
    const nb = await live.read({ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'ann' });
    assert.strictEqual(nb.markdown, '# Live\nFresh words');
    assert.deepStrictEqual(calls, [['notebook', 'nb1']]);

    const broken = reader({ collab: () => ({ isActive: async () => true, readMarkdown: async () => { throw new Error('down'); } }) });
    assert.strictEqual((await broken.read({ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'ann' })).markdown, '# Notes\nHello');

    const notebookWithoutMirror = reader({
        getNotebook: async () => ({ id: 'nb1', name: 'R', projectId: 'p1', documentMd: null, documentContent: '<p>Old html</p>' }),
    });
    assert.strictEqual((await notebookWithoutMirror.read({ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'ann' })).markdown, 'MD(Old html)');
});

test('sectionHtmlOf finds a section by its exact id only', () => {
    const html = '<div data-doc-section="a"><p>A</p></div><div data-doc-section="a-b"><p>B</p></div>';
    assert.strictEqual(sectionHtmlOf(html, 'a-b', domParser), '<p>B</p>');
    assert.strictEqual(sectionHtmlOf(html, 'a"]', domParser), '');
    assert.strictEqual(sectionHtmlOf('', 'a', domParser), '');
});

test('a task is read as its title and description, only for the project it is in', async () => {
    const reader = makeItemReader({
        readTask: async ({ projectId, taskId }) => (projectId === 'p1' && taskId === 't1' ? { title: 'Send the offer', description: 'Before Friday.' } : null),
    });
    const item = await reader.read({ projectId: 'p1', targetType: 'task', targetId: 't1', userId: 'ann' });
    assert.deepStrictEqual(item, { name: 'Send the offer', markdown: '# Send the offer\n\nBefore Friday.', sectionMarkdown: '' });
    assert.strictEqual(await reader.read({ projectId: 'p2', targetType: 'task', targetId: 't1', userId: 'ann' }), null);
    assert.strictEqual(await reader.read({ projectId: 'p1', targetType: 'task', targetId: 't1', userId: null }), null);
});

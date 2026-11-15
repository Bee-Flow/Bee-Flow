// @typecheck strict
'use strict';
/**
 * The heading outline of the server-rendered page (core/seo/renderBlocks.js):
 * one h1, then every block starting at h2, whatever depth its headings sit at.
 *
 * Run: cd server && node --test core/seo/renderBlocksHeadings.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBlocks, PREHYDRATE_CSS } = require('./renderBlocks');

/** The heading tags in document order, as `h2:Text`. */
const outline = (/** @type {string} */ html) => [...html.matchAll(/<(h[1-6])[^>]*>([^<]*)<\/h[1-6]>/g)].map((m) => `${m[1]}:${m[2]}`);

const contentBlock = {
    type: 'content',
    content: {
        columns: [
            { elements: [{ kind: 'image', src: 'cms/a.png', alt: '' }] },
            { elements: [
                { kind: 'text', heading: 'Why it matters', body: 'Body one.' },
                { kind: 'text', heading: 'How it works', body: 'Body two.' },
            ] },
        ],
    },
};

test('a content block right after the hero opens with an h2, its other elements are h3', () => {
    const html = renderBlocks([
        { type: 'hero', content: { title: 'Bee Flow' } },
        contentBlock,
    ]);
    assert.deepEqual(outline(html), ['h1:Bee Flow', 'h2:Why it matters', 'h3:How it works']);
});

test('a promoted heading keeps the size its depth gave it before hydration', () => {
    const html = renderBlocks([{ type: 'hero', content: { title: 'Bee Flow' } }, contentBlock]);
    assert.match(html, /<h2 class="h4">Why it matters<\/h2>/);
    assert.match(html, /<h3 class="h4">How it works<\/h3>/);
    assert.match(PREHYDRATE_CSS, /\.cms-prehydrate \.h3, \.cms-prehydrate \.h4 \{/);
});

test('a block with its own title and items stays h2 → h3 → h4', () => {
    const html = renderBlocks([
        { type: 'hero', content: { title: 'Top' } },
        { type: 'features', content: { title: 'Features', categories: [
            { title: 'Chat', items: [{ title: 'Memory' }] },
        ] } },
    ]);
    assert.deepEqual(outline(html), ['h1:Top', 'h2:Features', 'h3:Chat', 'h4:Memory']);
    assert.doesNotMatch(html, /class="h/, 'nothing promoted, so no size class');
});

test('every block starts its own outline at h2', () => {
    const html = renderBlocks([
        { type: 'hero', content: { title: 'Top' } },
        contentBlock,
        { type: 'faq', content: { title: 'Questions', items: [{ question: 'Is it free?', answer: 'Yes.' }] } },
    ]);
    assert.deepEqual(outline(html), [
        'h1:Top', 'h2:Why it matters', 'h3:How it works', 'h2:Questions', 'h3:Is it free?',
    ]);
});

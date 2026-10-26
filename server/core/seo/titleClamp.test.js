// @typecheck strict
const test = require('node:test');
const assert = require('node:assert');
const { clampTitle } = require('./html');
const { buildHead } = require('./head');

test('a long title keeps its brand suffix whole and shortens the page part', () => {
    const t = clampTitle('AI-agents, automatiseringen en apps in één platform voor teams | Bee Flow', 60, 'Bee Flow');
    assert.ok(t.length <= 60, t);
    assert.ok(t.endsWith(' | Bee Flow'), t);
    assert.ok(!/\s…\s\|/.test(t) && t.includes('…'), t);
});

test('a title that fits is returned untouched', () => {
    assert.strictEqual(clampTitle('Pricing | Bee Flow', 60, 'Bee Flow'), 'Pricing | Bee Flow');
});

test('the brand is dropped when the page part would be left too short', () => {
    const t = clampTitle('Extraordinarily-long-unbroken-single-word-title-without-any-spaces-at-all | Bee Flow', 25, 'Bee Flow');
    assert.ok(t.length <= 25, t);
    assert.ok(!t.includes('Bee'), t);
});

test('a title without a brand suffix is cut at a word boundary', () => {
    const t = clampTitle('word '.repeat(30), 60, 'Bee Flow');
    assert.ok(t.length <= 60);
    assert.ok(t.endsWith('…'));
});

test('buildHead never emits "| Bee…" in title, og:title or twitter:title', () => {
    const head = buildHead({
        origin: 'https://example.test', slug: 'platform', locale: 'nl', defaultLocale: 'en', locales: ['en', 'nl'],
        page: { title: 'x', seo: { metaTitle: 'AI-agents, automatiseringen en apps in één platform | Bee Flow' }, blocks: [] },
        design: {}, siteName: 'Bee Flow',
    });
    assert.ok(!head.includes('Bee…'), head);
    assert.ok(head.includes('| Bee Flow</title>'));
    assert.ok(head.includes('content="AI-agents'));
    assert.match(head, /og:title" content="[^"]*\| Bee Flow"/);
});

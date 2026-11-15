// @typecheck strict
'use strict';
/**
 * llms.txt sections (core/seo/sitemap.js buildLlmsTxt): pages, comparisons
 * (also the vs-* pages), the newest posts as Guides, and the fixed links.
 *
 * Run: cd server && node --test core/seo/llmsTxt.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLlmsTxt, LLMS_GUIDES } = require('./sitemap');

const ORIGIN = 'https://beeflow.test';
const PAGES = [
    { slug: 'home', title: 'Home', isHomepage: true, seo: {}, locales: ['en', 'nl'] },
    { slug: 'pricing', title: 'Pricing', seo: { metaDescription: 'Plans.' }, locales: ['en'] },
    { slug: 'vs-open-webui', title: 'Bee Flow vs Open WebUI', seo: {} },
    { slug: 'n8n-alternative', title: 'vs n8n', seo: {} },
];

/** The lines under one `## heading`, up to the next blank line. */
function section(/** @type {string} */ txt, /** @type {string} */ heading) {
    const lines = txt.split('\n');
    const at = lines.indexOf(`## ${heading}`);
    if (at < 0) return [];
    const rest = lines.slice(at + 2);
    const end = rest.indexOf('');
    return end < 0 ? rest : rest.slice(0, end);
}

test('vs-* pages are comparisons, not general pages', () => {
    const txt = buildLlmsTxt(PAGES, { origin: ORIGIN });
    assert.deepEqual(section(txt, 'Comparisons'), [
        `- [Bee Flow vs Open WebUI](${ORIGIN}/vs-open-webui)`,
        `- [vs n8n](${ORIGIN}/n8n-alternative)`,
    ]);
    assert.ok(!section(txt, 'Pages').some((l) => l.includes('vs-open-webui')));
});

test('the newest posts are listed as Guides, and the fixed links close the file', () => {
    const txt = buildLlmsTxt(PAGES, {
        origin: ORIGIN, guides: [{ title: 'Why EU hosting', url: `${ORIGIN}/blog/why-eu-hosting` }, { title: '', url: 'x' }],
    });
    assert.deepEqual(section(txt, 'Guides'), [`- [Why EU hosting](${ORIGIN}/blog/why-eu-hosting)`]);
    assert.deepEqual(section(txt, 'Links'), [
        '- [Documentation](https://docs.beeflow.ai)',
        '- [Source code (GitHub)](https://github.com/Bee-Flow/Bee-Flow)',
        '- [Nextcloud App Store](https://apps.nextcloud.com/apps/bee_flow)',
    ]);
    assert.equal(LLMS_GUIDES, 15);
    assert.ok(txt.indexOf('## Guides') < txt.indexOf('## Links'));
});

test('a translated page lists its other-language address after its own', () => {
    const txt = buildLlmsTxt(PAGES, { origin: ORIGIN, defaultLocale: 'en' });
    assert.ok(section(txt, 'Pages').includes(`- [Home](${ORIGIN}/) (nl: ${ORIGIN}/nl)`));
    assert.ok(section(txt, 'Pages').includes(`- [Pricing](${ORIGIN}/pricing): Plans.`));
});

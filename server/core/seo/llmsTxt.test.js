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
const { buildLlmsTxt, llmsGuides, LLMS_GUIDES } = require('./sitemap');

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

/** Any amount of money in the text: a currency sign, code or word next to a number, or a number per user/month. */
const PRICE = /[€$£]\s?\d|\d\s?(?:€|EUR|USD|GBP|euros?|dollars?)\b|\b(?:EUR|USD|GBP)\s?\d|\d\s?(?:per|a|\/)\s?(?:user|month|seat)\b/i;

test('a facts block from the site settings follows the summary, and no price reaches the file', () => {
    const facts = {
        name: 'Acme', legalName: 'Acme B.V.', description: 'Acme is a workspace for firms.',
        email: 'info@acme.test', address: 'Main street 1, 1000 AA Town, Netherlands',
        registration: 'KvK 12345678', vat: null, profiles: ['https://github.com/acme/acme'],
    };
    const pages = [
        ...PAGES,
        { slug: 'plans', title: 'Plans', seo: { metaDescription: 'Free forever; paid licences from €6 per user per month.' } },
        { slug: 'kosten', title: 'Costs', seo: { metaDescription: 'A fixed price agreed before building starts.' } },
    ];
    const txt = buildLlmsTxt(pages, { origin: ORIGIN, siteName: 'Acme', summary: 'Starts at 6 EUR a month.', facts });
    assert.deepEqual(section(txt, 'Facts'), [
        '- Name: Acme',
        '- What it is: Acme is a workspace for firms.',
        '- Legal entity: Acme B.V., KvK 12345678',
        '- Registered address: Main street 1, 1000 AA Town, Netherlands',
        '- Contact: info@acme.test',
        '- Profile: https://github.com/acme/acme',
    ]);
    assert.ok(txt.indexOf('## Facts') < txt.indexOf('## Pages'));
    // The page stays listed; only its priced description is dropped.
    assert.ok(section(txt, 'Pages').includes(`- [Plans](${ORIGIN}/plans)`));
    assert.ok(section(txt, 'Pages').includes(`- [Costs](${ORIGIN}/kosten): A fixed price agreed before building starts.`));
    assert.doesNotMatch(txt, PRICE);
});

test('a price written in words is dropped too, from descriptions, guide titles and link titles', () => {
    const pages = [
        ...PAGES,
        { slug: 'plans', title: 'Plans', seo: { metaDescription: 'Paid licences from 6 euro per user per month.' } },
        { slug: 'us', title: 'US', seo: { metaDescription: 'Ten dollars? No: 10 dollars a seat.' } },
        { slug: 'team', title: 'Team', seo: { metaDescription: 'Just 6 per user per month.' } },
    ];
    const txt = buildLlmsTxt(pages, {
        origin: ORIGIN,
        guides: [
            { title: 'Why EU hosting', url: `${ORIGIN}/blog/why-eu-hosting` },
            { title: 'Bee Flow now 5 euros a month', url: `${ORIGIN}/blog/price-cut` },
        ],
        links: [{ title: 'Docs', url: 'https://docs.acme.test' }, { title: 'Buy for 99 EUR', url: 'https://shop.acme.test' }],
    });
    assert.ok(section(txt, 'Pages').includes(`- [Plans](${ORIGIN}/plans)`));
    assert.ok(section(txt, 'Pages').includes(`- [Team](${ORIGIN}/team)`));
    assert.deepEqual(section(txt, 'Guides'), [`- [Why EU hosting](${ORIGIN}/blog/why-eu-hosting)`]);
    assert.deepEqual(section(txt, 'Links'), ['- [Docs](https://docs.acme.test)']);
    assert.doesNotMatch(txt, PRICE);
});

test('a site that states nothing but its name gets no facts block', () => {
    const facts = { name: 'Acme', legalName: null, description: null, email: null, address: null, registration: null, vat: null, profiles: [] };
    assert.deepEqual(section(buildLlmsTxt(PAGES, { origin: ORIGIN, facts }), 'Facts'), []);
});

test('Guides leave out a post marked noIndex and stop at LLMS_GUIDES', () => {
    const posts = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, slug: `post-${i}`, title: `Post ${i}` }));
    const guides = llmsGuides(posts, {
        origin: ORIGIN, defaultLocale: 'en', storedPosts: { p0: { seo: { noIndex: true } } },
    });
    assert.equal(guides.length, LLMS_GUIDES);
    assert.deepEqual(guides[0], { title: 'Post 1', url: `${ORIGIN}/blog/post-1` });
    assert.ok(!guides.some((g) => g.url.endsWith('/post-0')));
});

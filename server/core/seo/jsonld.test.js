// @typecheck strict
'use strict';
/**
 * The JSON-LD graph (core/seo/jsonld.js) and the head values around it
 * (core/seo/head.js): what the site states about itself, and nothing a
 * visitor cannot see.
 *
 * Run: cd server && node --test core/seo/jsonld.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildJsonLd, faqPage, LICENSE_URL } = require('./jsonld');
const { buildHead, footerProfiles } = require('./head');
const { ogLocale } = require('./html');

const ORIGIN = 'https://beeflow.test';

/** @param {Record<string, unknown>} [over] */
const graphOf = (over = {}) => buildJsonLd({
    origin: ORIGIN, siteName: 'Bee Flow', url: `${ORIGIN}/`, title: 'Home', description: 'd',
    locale: 'en', slug: '', localePrefix: '', blocks: [], ...over,
})['@graph'];

/** @param {string} head */
const headGraph = (head) => JSON.parse(/** @type {RegExpMatchArray} */ (head.match(/<script type="application\/ld\+json">([^]*?)<\/script>/))[1])['@graph'];

test('a switched-off faq block (or item) emits no FAQPage', () => {
    const items = [{ question: 'Q?', answer: 'A.' }];
    assert.equal(faqPage([{ id: 'b1', type: 'faq', enabled: false, content: { items } }]), null);
    assert.equal(faqPage([{ id: 'b1', type: 'faq', content: { items: [{ ...items[0], enabled: false }] } }]), null);
    assert.equal(faqPage([{ id: 'b1', type: 'faq', content: { items } }])?.mainEntity.length, 1);
});

test('a WebSite node names the site, its address and its languages; the page is part of it', () => {
    const graph = graphOf({ locales: ['en', 'nl'] });
    const site = graph.find((n) => n['@type'] === 'WebSite');
    assert.deepEqual(site, {
        '@type': 'WebSite', '@id': `${ORIGIN}/#website`, name: 'Bee Flow', url: `${ORIGIN}/`,
        inLanguage: ['en', 'nl'], publisher: { '@id': `${ORIGIN}/#organization` },
    });
    assert.deepEqual(graph.find((n) => n['@type'] === 'WebPage')?.isPartOf, { '@id': `${ORIGIN}/#website` });
    assert.equal(graphOf().find((n) => n['@type'] === 'WebSite')?.inLanguage, 'en');
});

test('the Organization carries the registered address, the e-mail address and its profiles', () => {
    const org = graphOf().find((n) => n['@type'] === 'Organization');
    assert.deepEqual(org?.address, {
        '@type': 'PostalAddress', streetAddress: 'Bovenkerkerweg 6 unit 1.12', postalCode: '1185 XE',
        addressLocality: 'Amstelveen', addressCountry: 'NL',
    });
    assert.equal(org?.email, 'info@beeflow.nl');
    assert.deepEqual(org?.sameAs, ['https://github.com/Bee-Flow/Bee-Flow', 'https://apps.nextcloud.com/apps/bee_flow']);
});

test('the SoftwareApplication names its licence and only the free offer', () => {
    const app = graphOf({ isProductPage: true }).find((n) => n['@type'] === 'SoftwareApplication');
    assert.equal(app?.license, LICENSE_URL);
    assert.equal(LICENSE_URL, 'https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md');
    assert.deepEqual(app?.offers, { '@type': 'Offer', price: '0', priceCurrency: 'EUR' });
});

test('the footer social links become sameAs, next to the known profiles and without duplicates', () => {
    const footer = { socials: [
        { platform: 'linkedin', link: { href: 'https://www.linkedin.com/company/bee-flow' } },
        { platform: 'github', link: { href: 'https://github.com/Bee-Flow/Bee-Flow' } },
        { platform: 'x', link: { href: '/internal' } },
        { platform: 'mastodon', enabled: false, link: { href: 'https://example.social/@bf' } },
    ] };
    assert.deepEqual(footerProfiles(footer), ['https://www.linkedin.com/company/bee-flow', 'https://github.com/Bee-Flow/Bee-Flow']);
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en', locales: ['en'],
        page: { title: 'Home', blocks: [] }, design: {}, siteName: 'Bee Flow', footer,
    });
    const org = headGraph(head).find((/** @type {any} */ n) => n['@type'] === 'Organization');
    assert.deepEqual(org.sameAs, [
        'https://www.linkedin.com/company/bee-flow', 'https://github.com/Bee-Flow/Bee-Flow',
        'https://apps.nextcloud.com/apps/bee_flow',
    ]);
});

test('og:locale is language_TERRITORY', () => {
    assert.equal(ogLocale('en'), 'en_GB');
    assert.equal(ogLocale('nl'), 'nl_NL');
    assert.equal(ogLocale('pt-BR'), 'pt_BR');
    const head = buildHead({
        origin: ORIGIN, slug: 'pricing', locale: 'nl', defaultLocale: 'en', locales: ['en', 'nl'],
        page: { title: 'Prijzen', blocks: [] }, design: {}, siteName: 'Bee Flow',
    });
    assert.match(head, /<meta property="og:locale" content="nl_NL">/);
    assert.match(head, /<meta property="og:locale:alternate" content="en_GB">/);
});

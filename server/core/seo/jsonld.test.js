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
const { buildJsonLd, faqPage } = require('./jsonld');
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

test('the Organization states only what the site settings state: no facts, no address or e-mail', () => {
    const org = graphOf().find((n) => n['@type'] === 'Organization');
    assert.deepEqual(org, { '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'Bee Flow', url: `${ORIGIN}/` });
});

test('the footer and header become the Organization: legal name, address, KvK number, e-mail, logo and profiles', () => {
    const footer = {
        copyright: '© Acme B.V.',
        socials: [{ platform: 'github', link: { kind: 'external', url: 'https://github.com/acme/acme' } }],
        accountability: {
            address: 'Main street 6, 1185 XE Amstelveen, Netherlands', registration: 'KvK 97632430',
            links: [{ label: 'info@acme.test', href: 'mailto:info@acme.test' }],
        },
    };
    const header = { nav: [{ label: 'Source', link: { kind: 'external', url: 'https://github.com/acme/acme' } }] };
    for (const slug of ['', 'pricing']) {
        const head = buildHead({
            origin: ORIGIN, slug, locale: 'en', defaultLocale: 'en', locales: ['en'],
            page: { title: 'Home', blocks: [] }, design: { logo: 'cms/logo.png' }, siteName: 'Acme', footer, header,
        });
        const org = headGraph(head).find((/** @type {any} */ n) => n['@type'] === 'Organization');
        assert.deepEqual(org, {
            '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'Acme', url: `${ORIGIN}/`,
            legalName: 'Acme B.V.', email: 'info@acme.test',
            address: { '@type': 'PostalAddress', streetAddress: 'Main street 6', postalCode: '1185 XE', addressLocality: 'Amstelveen', addressCountry: 'NL' },
            identifier: { '@type': 'PropertyValue', propertyID: 'KvK', value: '97632430' },
            logo: `${ORIGIN}/api/cms/asset/cms/logo.png`,
            sameAs: ['https://github.com/acme/acme'],
        });
    }
});

const LICENSE = 'https://git.acme.test/acme/blob/main/LICENSE.md';
/** Facts of a site whose footer links a licence. */
const LICENSED = {
    name: 'Acme', legalName: null, description: null, email: null, address: null, registration: null, vat: null,
    profiles: [], links: [{ title: 'Licence', url: LICENSE }], licenseUrl: LICENSE,
};

test('the SoftwareApplication names the licence the footer links, and only the free offer', () => {
    const app = graphOf({ isProductPage: true, facts: LICENSED }).find((n) => n['@type'] === 'SoftwareApplication');
    assert.equal(app?.license, LICENSE);
    assert.deepEqual(app?.offers, { '@type': 'Offer', price: '0', priceCurrency: 'EUR' });
});

test('a site whose footer links no licence gets no SoftwareApplication, product page or not', () => {
    assert.ok(!graphOf({ isProductPage: true }).some((n) => n['@type'] === 'SoftwareApplication'));
    assert.ok(!graphOf({ isProductPage: true, facts: { ...LICENSED, licenseUrl: null } })
        .some((n) => n['@type'] === 'SoftwareApplication'));
});

test('the licence comes from the footer columns through buildHead', () => {
    const footer = { columns: [{ heading: 'Company', links: [
        { label: 'Docs', link: { kind: 'external', url: 'https://docs.acme.test' } },
        { label: 'Sustainable Use License', link: { kind: 'external', url: LICENSE } },
    ] }] };
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en', locales: ['en'],
        page: { title: 'Home', blocks: [] }, design: {}, siteName: 'Acme', footer, header: {},
    });
    const app = headGraph(head).find((/** @type {any} */ n) => n['@type'] === 'SoftwareApplication');
    assert.equal(app?.license, LICENSE);
});

test('the footer social links become sameAs, without duplicates', () => {
    const footer = { socials: [
        { platform: 'linkedin', link: { href: 'https://www.linkedin.com/company/bee-flow' } },
        { platform: 'github', link: { href: 'https://github.com/Bee-Flow/Bee-Flow' } },
        { platform: 'github', link: { kind: 'external', url: 'https://github.com/Bee-Flow/Bee-Flow' } },
        { platform: 'x', link: { href: '/internal' } },
        { platform: 'mastodon', enabled: false, link: { href: 'https://example.social/@bf' } },
    ] };
    assert.deepEqual(footerProfiles(footer), [
        'https://www.linkedin.com/company/bee-flow', 'https://github.com/Bee-Flow/Bee-Flow', 'https://github.com/Bee-Flow/Bee-Flow',
    ]);
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en', locales: ['en'],
        page: { title: 'Home', blocks: [] }, design: {}, siteName: 'Bee Flow', footer,
    });
    const org = headGraph(head).find((/** @type {any} */ n) => n['@type'] === 'Organization');
    assert.deepEqual(org.sameAs, ['https://www.linkedin.com/company/bee-flow', 'https://github.com/Bee-Flow/Bee-Flow']);
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

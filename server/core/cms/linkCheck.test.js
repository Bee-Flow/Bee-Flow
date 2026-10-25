// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectLinks, checkInternalLinks, pathResolves } = require('./linkCheck');

const known = {
    pageIds: new Set(['pg_1', 'pg_2']),
    slugs: new Set(['pricing', 'privacy']),
    postSlugs: new Set(['hello']),
    redirectFroms: new Set(['/old-page']),
};
const payload = {
    site: {
        pages: [{ id: 'pg_1', slug: 'home' }, { id: 'pg_2', slug: 'pricing' }],
        header: { nav: [{ label: 'Gone', link: { kind: 'page', pageId: 'pg_9' } }, { label: 'Ok', link: { kind: 'page', pageId: 'pg_2' } }] },
        cookieBanner: { text: { en: { privacyUrl: '/privacy' }, nl: { privacyUrl: '/terms' } } },
    },
    pages: [{ id: 'pg_1', blocks: [{ cta: { link: { kind: 'external', url: 'https://example.org/a?token=secret#x' } } }] }],
    localeOverrides: { siteByLocale: {}, pagesByLocale: { pg_1: { nl: [{ link: { kind: 'app', path: '/nl/missing' } }] } } },
};

test('collects links from chrome, pages and locale overrides', () => {
    const links = collectLinks(payload);
    assert.equal(links.filter((l) => l.type === 'page').length, 2);
    assert.equal(links.filter((l) => l.type === 'external').length, 1);
    assert.ok(links.some((l) => l.where.includes('privacyUrl') && l.target === '/terms'));
    assert.ok(links.some((l) => l.where.startsWith('page home') && l.where.includes('(nl)')));
});

test('internal problems: missing page, unknown path; query strings never reported', () => {
    const { problems, external, checked } = checkInternalLinks(collectLinks(payload), known);
    assert.deepEqual(problems.map((p) => p.code).sort(), ['page_missing', 'path_not_found', 'path_not_found']);
    assert.equal(external.length, 1);
    assert.equal(checked, 5);
    assert.ok(!JSON.stringify(problems).includes('secret'));
});

test('path resolution: home, locale prefix, pages, posts, redirects, app routes, legal docs', () => {
    for (const ok of ['/', '/nl', '/nl/pricing', '/pricing#faq', '/pricing?x=1', '/blog', '/blog/hello', '/old-page', '/app/chat', '/sitemap.xml', '/legal/privacy']) {
        assert.equal(pathResolves(ok, known), true, ok);
    }
    for (const bad of ['/terms', '/pricing/extra', '/blog/nope', '/legal/terms', '/nl/nope']) {
        assert.equal(pathResolves(bad, known), false, bad);
    }
});

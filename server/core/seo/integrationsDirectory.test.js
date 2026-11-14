'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const dir = require('./integrationsDirectory');
const { createIntegrationsRouter, integrationCatalog } = require('../../routes/publicIntegrationsRender');
const { buildSitemap } = require('./sitemap');

const SOURCE = {
    INTEGRATION_CATALOG: [
        { id: 'gmail', name: 'Gmail', description: 'Send and read emails', category: 'Google Workspace' },
        { id: 'google-calendar', name: 'Calendar', description: 'Manage calendar events', category: 'Google Workspace' },
        { id: 'xss', name: '<script>alert(1)</script>', description: 'a "quoted" & <b>bold</b>', category: 'AI & Media' },
        { id: 'Bad_ID', name: 'skipped', description: 'x', category: 'Other' },
    ],
    NC_INTEGRATIONS: [{ id: 'nextcloud-calendar', name: 'Calendar', description: 'CalDAV events' }],
};
const items = dir.listGalleryItems(SOURCE);

test('items come from the catalogue; vendor prefix disambiguates; bad ids are dropped', () => {
    assert.deepEqual(items.map(i => i.id), ['gmail', 'google-calendar', 'xss', 'nextcloud-calendar']);
    assert.equal(items.find(i => i.id === 'google-calendar').title, 'Google Calendar');
    assert.equal(items.find(i => i.id === 'nextcloud-calendar').title, 'Nextcloud Calendar');
    assert.equal(items.find(i => i.id === 'gmail').title, 'Gmail');
});

test('the real catalogue produces unique, routable ids', () => {
    const real = dir.listGalleryItems();
    assert.ok(real.length > 40);
    assert.equal(new Set(real.map(i => i.id)).size, real.length);
    assert.ok(real.every(i => !i.id.startsWith('custom:') && !i.id.startsWith('mcp:')));
});

test('filterItems: every word must match, category narrows', () => {
    assert.deepEqual(dir.filterItems(items, { q: 'calendar' }).map(i => i.id), ['google-calendar', 'nextcloud-calendar']);
    assert.deepEqual(dir.filterItems(items, { q: 'calendar nextcloud' }).map(i => i.id), ['nextcloud-calendar']);
    assert.deepEqual(dir.filterItems(items, { category: 'google-workspace' }).map(i => i.id), ['gmail', 'google-calendar']);
    assert.equal(dir.filterItems(items, { q: 'zzz' }).length, 0);
});

test('directory page escapes everything and marks a filtered view noindex', () => {
    const html = dir.renderDirectoryPage({ origin: 'https://x.test', siteName: 'A"B', items, q: '"><script>x</script>' });
    assert.ok(!html.includes('<script>x'));
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /noindex/);
    const full = dir.renderDirectoryPage({ origin: 'https://x.test', siteName: 'Bee Flow', items });
    assert.ok(!/noindex/.test(full));
    assert.match(full, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(full, /rel="canonical" href="https:\/\/x\.test\/integrations\/directory"/);
    assert.match(full, /<form class="filter" role="search" method="get"/);
    assert.match(full, /<label class="sr" for="q">/);
});

test('header and breadcrumb link /integrations and /blog only when they exist', () => {
    const base = { origin: 'https://x.test', siteName: 'Bee Flow', items };
    const none = dir.renderDirectoryPage(base);
    assert.ok(!none.includes('href="/blog"') && !none.includes('href="/integrations"'));
    const some = dir.renderDirectoryPage({ ...base, nav: { integrations: true, blog: true } });
    assert.ok(some.includes('href="/blog"') && some.includes('href="/integrations"'));
    const detail = dir.renderDetailPage({ ...base, item: items[0], related: items });
    assert.ok(!detail.includes('href="/integrations"'));
});

test('detail page: "Bee Flow + Nextcloud Calendar" h1, its own title, breadcrumb JSON-LD', () => {
    const item = items.find(i => i.id === 'nextcloud-calendar');
    const html = dir.renderDetailPage({ origin: 'https://x.test', siteName: 'Bee Flow', item, related: items });
    assert.match(html, /<h1>Bee Flow \+ Nextcloud Calendar<\/h1>/);
    assert.match(html, /<title>Nextcloud Calendar integration via CalDAV \| Bee Flow<\/title>/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, /href="https:\/\/x\.test\/integrations\/nextcloud-calendar"/);
});

test('detail page without prose keeps the catalogue line as title and description', () => {
    const item = items.find(i => i.id === 'xss');
    const html = dir.renderDetailPage({ origin: 'https://x.test', siteName: 'Bee Flow', item, related: items });
    assert.match(html, /<title>Bee Flow \+ &lt;script&gt;alert\(1\)&lt;\/script&gt; \| Bee Flow<\/title>/);
    assert.ok(!html.includes('<script>alert'));
});

test('sitemap entries cover the directory and each integration', () => {
    const xml = buildSitemap(dir.integrationSitemapEntries(items, { defaultLocale: 'en', lastmod: '2026-01-02' }), { origin: 'https://x.test' });
    assert.match(xml, /<loc>https:\/\/x\.test\/integrations\/directory<\/loc>/);
    assert.match(xml, /<loc>https:\/\/x\.test\/integrations\/gmail<\/loc>/);
});

async function get(app, path) {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        return await new Promise((resolve, reject) => {
            http.get({ port, path, host: '127.0.0.1' }, (res) => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
            }).on('error', reject);
        });
    } finally { server.close(); }
}

function appWith({ siteId = 'site1', snapshot = { site: { header: { logoText: 'Bee Flow' } } }, locales = ['en'] } = {}) {
    const app = express();
    app.use(createIntegrationsRouter({
        resolveOrigin: () => 'https://x.test', getLiveSiteId: async () => siteId, getSnapshot: async () => snapshot,
        siteLocales: async () => ({ defaultLocale: 'en', locales }),
    }));
    app.use((req, res) => res.status(404).send('fell through'));
    return app;
}

test('router serves the directory with a server-side search', async () => {
    const res = await get(appWith(), '/integrations/directory?q=gmail');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /href="\/integrations\/gmail"/);
    assert.ok(!res.body.includes('href="/integrations/github"'));
});

test('router serves a detail page, and falls through for unknown ids and without a published site', async () => {
    assert.equal((await get(appWith(), '/integrations/gmail')).status, 200);
    assert.equal((await get(appWith(), '/integrations/nope')).body, 'fell through');
    assert.equal((await get(appWith({ siteId: null }), '/integrations/gmail')).body, 'fell through');
    assert.equal((await get(appWith({ snapshot: null }), '/integrations/directory')).body, 'fell through');
});

// ── Long-form content and the Dutch pages ─────────────────────────────────

const real = dir.listGalleryItems();
const realItem = (id) => real.find(i => i.id === id);
const BILINGUAL = { locales: ['en', 'nl'], snapshot: {
    site: { header: { logoText: 'Bee Flow' }, pages: [{ id: 'p1', slug: 'integrations' }, { id: 'p2', slug: 'deployment' }, { id: 'p3', slug: 'plans' }] },
    pageLocaleOverrides: { p1: { nl: { blocks: { a: {} } } }, p2: { nl: { blocks: { a: {} } } } },
} };

/** The visible text of a page: tags out, the entities esc() writes turned back. */
function textOf(html) {
    return html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

test('an English page carries the long-form sections, tools from the catalogue and no script but JSON-LD', async () => {
    const res = await get(appWith(BILINGUAL), '/integrations/gmail');
    assert.equal(res.status, 200);
    const html = res.body;
    assert.match(html, /<title>Gmail integration: search, draft and sort mail \| Bee Flow<\/title>/);
    assert.match(html, /<h2[^>]*>What an assistant can do<\/h2>/);
    assert.match(html, /<code>gmail_search<\/code>/);
    assert.match(html, /<h2[^>]*>Events that can start an automation<\/h2>/);
    assert.match(textOf(html), /New email/);
    assert.match(html, /href="\/integrations"/);
    assert.match(html, /href="\/deployment"/);
    assert.match(html, /href="\/plans"/);
    assert.match(html, /<link rel="alternate" hreflang="nl" href="https:\/\/x\.test\/nl\/integrations\/gmail">/);
    assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/x\.test\/integrations\/gmail">/);
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 1);
    for (const [, attrs, body] of scripts) {
        assert.equal(attrs.trim(), 'type="application/ld+json"');
        JSON.parse(body);
    }
});

test('the Dutch page is served under /nl/ with lang, canonical and hreflang, and links to Dutch pages that exist', async () => {
    const res = await get(appWith(BILINGUAL), '/nl/integrations/afas-profit');
    assert.equal(res.status, 200);
    const html = res.body;
    assert.match(html, /<html lang="nl">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/x\.test\/nl\/integrations\/afas-profit">/);
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/x\.test\/integrations\/afas-profit">/);
    assert.match(html, /<h2[^>]*>Wat een assistent ermee kan<\/h2>/);
    assert.match(html, /<code>afas_query<\/code>/);
    assert.match(textOf(html), /Alleen lezen: geen van deze tools wijzigt iets\./);
    assert.match(html, /href="\/nl\/integrations"/);
    assert.match(html, /href="\/nl\/deployment"/);
    assert.match(html, /href="\/plans"/, 'no Dutch plans page: the English one');
    assert.match(html, /href="\/nl\/integrations\/nmbrs"/);
});

test('a Dutch URL falls through when the site has no Dutch, and redirects when the page has no Dutch text', async () => {
    assert.equal((await get(appWith(), '/nl/integrations/gmail')).body, 'fell through');
    assert.equal((await get(appWith(BILINGUAL), '/xx/integrations/gmail')).body, 'fell through');
    assert.equal((await get(appWith(BILINGUAL), '/en/integrations/gmail')).body, 'fell through', 'the default locale has no prefix');
    const redirect = await get(appWith(BILINGUAL), '/nl/integrations/music-gen');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/integrations/music-gen');
    assert.equal((await get(appWith(BILINGUAL), '/nl/integrations/nope')).body, 'fell through');
});

test('the Dutch directory searches in Dutch and links to the Dutch pages', async () => {
    const res = await get(appWith(BILINGUAL), '/nl/integrations/directory?q=salaris');
    assert.equal(res.status, 200);
    assert.match(res.body, /<html lang="nl">/);
    assert.match(res.body, /action="\/nl\/integrations\/directory"/);
    assert.match(res.body, /href="\/nl\/integrations\/nmbrs"/);
    assert.match(res.body, /noindex/);
    const full = await get(appWith(BILINGUAL), '/nl/integrations/directory');
    assert.match(full.body, /<link rel="canonical" href="https:\/\/x\.test\/nl\/integrations\/directory">/);
    assert.match(full.body, /AI en media/);
});

test('a page without prose keeps the catalogue line and offers no alternate', () => {
    const html = dir.renderDetailPage({ origin: 'https://x.test', siteName: 'Bee Flow', item: realItem('music-gen'), related: real, locales: ['en', 'nl'] });
    assert.ok(!html.includes('hreflang'));
    assert.match(html, /Generate music with AI/);
});

test('sitemap: Dutch integration URLs with their alternates, English only where there is no Dutch', () => {
    const xml = buildSitemap(dir.integrationSitemapEntries(real, { defaultLocale: 'en', locales: ['en', 'nl'], lastmod: '2026-01-02' }), { origin: 'https://x.test', defaultLocale: 'en', locales: ['en', 'nl'] });
    assert.match(xml, /<loc>https:\/\/x\.test\/nl\/integrations\/vplan<\/loc>/);
    assert.match(xml, /<loc>https:\/\/x\.test\/nl\/integrations\/directory<\/loc>/);
    assert.match(xml, /<xhtml:link rel="alternate" hreflang="nl" href="https:\/\/x\.test\/nl\/integrations\/firebird"\/>/);
    assert.ok(!xml.includes('/nl/integrations/music-gen'));
});

test('every real page: one h1, a title of at most 58 characters, a description of at most 155', () => {
    for (const locale of ['en', 'nl']) {
        for (const item of real) {
            const html = dir.renderDetailPage({ origin: 'https://x.test', siteName: 'Bee Flow', item, related: real, locale, locales: ['en', 'nl'], catalog: integrationCatalog() });
            const title = /<title>([^<]*)<\/title>/.exec(html)[1];
            assert.ok(textOf(title).length <= 58, `${locale} ${item.id}: ${title}`);
            const desc = /<meta name="description" content="([^"]*)">/.exec(html)[1];
            assert.ok(textOf(desc).length <= 155, `${locale} ${item.id}: description`);
            assert.equal((html.match(/<h1>/g) || []).length, 1);
        }
    }
});

test('the Dutch vPlan page as text', () => {
    const html = dir.renderDetailPage({ origin: 'https://x.test', siteName: 'Bee Flow', item: realItem('vplan'), related: real, locale: 'nl', locales: ['en', 'nl'], catalog: integrationCatalog() });
    const text = textOf(html);
    assert.match(text, /Bee Flow \+ vPlan/);
    assert.match(text, /vplan_get_capacity/);
    assert.match(text, /Deze koppeling heeft geen eigen gebeurtenissen voor automatiseringen\./);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const dir = require('./integrationsDirectory');
const { createIntegrationsRouter } = require('../../routes/publicIntegrationsRender');
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

test('detail page: "Bee Flow + Nextcloud Calendar" title, breadcrumb JSON-LD, siblings', () => {
    const item = items.find(i => i.id === 'nextcloud-calendar');
    const html = dir.renderDetailPage({ origin: 'https://x.test', siteName: 'Bee Flow', item, related: items });
    assert.match(html, /<title>Bee Flow \+ Nextcloud Calendar \| Bee Flow<\/title>/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, /href="https:\/\/x\.test\/integrations\/nextcloud-calendar"/);
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

function appWith({ siteId = 'site1', snapshot = { site: { header: { logoText: 'Bee Flow' } } } } = {}) {
    const app = express();
    app.use(createIntegrationsRouter({
        resolveOrigin: () => 'https://x.test', getLiveSiteId: async () => siteId, getSnapshot: async () => snapshot,
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

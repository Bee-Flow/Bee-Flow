// @typecheck strict
'use strict';
/**
 * The <head> of the public integration pages (core/seo/integrationsShell.js):
 * the same tags as every other public page (canonical, robots, og, twitter,
 * hreflang) and the site's Organization in the JSON-LD.
 *
 * Run: cd server && node --test core/seo/integrationsHead.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const dir = require('./integrationsDirectory');
const { createIntegrationsRouter } = require('../../routes/publicIntegrationsRender');

const ORIGIN = 'https://x.test';
const real = dir.listGalleryItems();
/** @param {string} id */
const item = (id) => /** @type {import('./integrationsShell').GalleryItem} */ (real.find(i => i.id === id));

const SITE = {
    header: { logoText: 'Acme' },
    design: { logo: 'cms/logo.png' },
    footer: {
        copyright: '© Acme B.V.',
        socials: [{ platform: 'github', link: { kind: 'external', url: 'https://github.com/acme/acme' } }],
        accountability: { registration: 'KvK 12345678', links: [{ label: 'info@acme.test', href: 'mailto:info@acme.test' }] },
    },
    pages: [{ id: 'p1', slug: 'integrations' }],
};

/** @param {import('express').Express} app @param {string} path @returns {Promise<{ status: number, body: string }>} */
async function get(app, path) {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        return await new Promise((resolve, reject) => {
            http.get({ port, path, host: '127.0.0.1' }, (res) => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ status: Number(res.statusCode), body }));
            }).on('error', reject);
        });
    } finally { server.close(); }
}

/** @param {Record<string, unknown>} [snapshot] */
function app(snapshot = { site: SITE }) {
    const a = express();
    a.use(createIntegrationsRouter({
        resolveOrigin: () => ORIGIN, getLiveSiteId: async () => 'site1', getSnapshot: async () => snapshot,
        siteLocales: async () => ({ defaultLocale: 'en', locales: ['en', 'nl'] }),
    }));
    return a;
}

/** @param {string} html @param {string} name @param {boolean} [property] */
function metaContent(html, name, property = false) {
    const attr = property ? 'property' : 'name';
    const at = html.indexOf(`<meta ${attr}="${name}" content="`);
    if (at === -1) return null;
    const start = at + `<meta ${attr}="${name}" content="`.length;
    return html.slice(start, html.indexOf('"', start));
}

/** @param {string} html */
function graphOf(html) {
    /** @type {any[]} */
    const nodes = [];
    for (const m of html.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)) {
        const doc = JSON.parse(m[1]);
        nodes.push(...(doc['@graph'] || [doc]));
    }
    return nodes;
}

test('a Dutch integration page has canonical, robots, og, twitter and hreflang tags', async () => {
    const res = await get(app(), '/nl/integrations/gmail');
    assert.equal(res.status, 200);
    const html = res.body;
    assert.match(html, /<link rel="canonical" href="https:\/\/x\.test\/nl\/integrations\/gmail">/);
    assert.equal(metaContent(html, 'robots'), 'index, follow, max-image-preview:large');
    assert.ok(metaContent(html, 'og:title', true));
    assert.ok(metaContent(html, 'og:description', true));
    assert.equal(metaContent(html, 'og:url', true), `${ORIGIN}/nl/integrations/gmail`);
    assert.equal(metaContent(html, 'og:locale', true), 'nl_NL');
    assert.equal(metaContent(html, 'og:locale:alternate', true), 'en_GB');
    assert.equal(metaContent(html, 'og:image', true), `${ORIGIN}/api/cms/asset/cms/logo.png`);
    assert.equal(metaContent(html, 'twitter:card'), 'summary');
    assert.equal(metaContent(html, 'twitter:title'), metaContent(html, 'og:title', true));
    assert.equal(metaContent(html, 'twitter:description'), metaContent(html, 'og:description', true));
    assert.equal(metaContent(html, 'twitter:image'), `${ORIGIN}/api/cms/asset/cms/logo.png`);
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/x\.test\/integrations\/gmail">/);
    assert.match(html, /<link rel="alternate" hreflang="nl" href="https:\/\/x\.test\/nl\/integrations\/gmail">/);
    assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/x\.test\/integrations\/gmail">/);
});

test('integration pages carry the site Organization from the site settings, and the page names its publisher', async () => {
    const html = (await get(app(), '/integrations/gmail')).body;
    const graph = graphOf(html);
    const org = graph.find(n => n['@type'] === 'Organization');
    assert.equal(org['@id'], `${ORIGIN}/#organization`);
    assert.equal(org.name, 'Acme');
    assert.equal(org.alternateName, 'Acme B.V.');
    assert.deepEqual(org.identifier, { '@type': 'PropertyValue', propertyID: 'KvK', value: '12345678' });
    assert.deepEqual(org.sameAs, ['https://github.com/acme/acme']);
    const page = graph.find(n => n['@type'] === 'WebPage');
    assert.deepEqual(page.publisher, { '@id': `${ORIGIN}/#organization` });
});

test('a Dutch integration page describes the Organization with the Dutch footer blurb, when the site has one', async () => {
    const site = { ...SITE, footer: { ...SITE.footer, blurb: 'Acme is a workspace for firms.' } };
    const translated = app({ site, siteLocaleOverrides: { nl: { footer: { blurb: 'Acme is een werkplek voor kantoren.' } } } });
    const orgOf = async (/** @type {import('express').Express} */ a, /** @type {string} */ path) =>
        graphOf((await get(a, path)).body).find(n => n['@type'] === 'Organization');
    assert.equal((await orgOf(translated, '/nl/integrations/gmail')).description, 'Acme is een werkplek voor kantoren.');
    assert.equal((await orgOf(translated, '/integrations/gmail')).description, 'Acme is a workspace for firms.');
    // Without a Dutch blurb the default-language one stays.
    assert.equal((await orgOf(app({ site }), '/nl/integrations/gmail')).description, 'Acme is a workspace for firms.');
});

test('the directory gets the same tags; an English-only catalogue page has no hreflang', async () => {
    const directory = (await get(app(), '/integrations/directory')).body;
    assert.equal(metaContent(directory, 'twitter:card'), 'summary');
    assert.equal(metaContent(directory, 'robots'), 'index, follow, max-image-preview:large');
    const thin = dir.renderDetailPage({ origin: ORIGIN, siteName: 'Acme', item: item('music-gen'), related: real, locales: ['en', 'nl'] });
    assert.ok(!thin.includes('hreflang'));
    assert.match(thin, /<link rel="canonical" href="https:\/\/x\.test\/integrations\/music-gen">/);
    assert.equal(metaContent(thin, 'twitter:card'), 'summary');
});

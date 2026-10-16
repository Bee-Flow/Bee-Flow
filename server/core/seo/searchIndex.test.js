'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { buildSearchIndex } = require('./searchIndex');
const { createSearchIndexRouter } = require('../../routes/publicSearchIndexRender');

const snapshot = {
    site: { pages: [
        { id: 'p1', slug: 'pricing', title: 'Pricing', isHomepage: false },
        { id: 'p2', slug: 'secret', title: 'Hidden page', isHomepage: false },
        { id: 'p3', slug: 'missing', title: '404', isNotFound: true },
        { id: 'p4', slug: 'home', title: 'Home', isHomepage: true },
    ] },
    pages: {
        p1: { title: 'Pricing', seo: { metaDescription: 'What it costs <b>x</b>' } },
        p2: { title: 'Hidden page', seo: { noIndex: true } },
        p3: { title: '404', seo: {} },
        p4: { title: 'Home', seo: {} },
    },
    posts: { po1: { id: 'po1', seo: {} }, po2: { id: 'po2', seo: { noIndex: true } }, po3: { id: 'po3', seo: {} } },
    postLocaleOverrides: { po1: { nl: { title: 'Hallo', body: 'Tekst' } } },
    pageLocaleOverrides: { p1: { nl: { blocks: {}, seo: { metaDescription: 'Wat het kost' } } } },
    siteLocaleOverrides: { nl: { pageTitles: { p1: 'Prijzen' } } },
};
const posts = [{ id: 'po1', slug: 'hello', title: 'Hello', excerpt: 'First post', tags: [{ label: 'News' }] }];
const integrations = [{ id: 'gmail', title: 'Gmail', description: 'Send and read emails' }];

test('default locale: indexable pages, posts and integrations; no hidden or 404 page', () => {
    const { entries } = buildSearchIndex({ snapshot, posts, integrations, locale: 'en', defaultLocale: 'en', locales: ['en', 'nl'] });
    assert.deepEqual(entries.map(e => e.u), ['/pricing', '/', '/blog/hello', '/integrations/gmail']);
    assert.deepEqual(entries.find(e => e.k === 'post').g, ['News']);
    assert.ok(!entries.some(e => e.t.includes('Hidden')));
});

test('posts: noIndex posts are dropped and a post without a translation is not offered in that locale', () => {
    const all = [...posts, { id: 'po2', slug: 'hidden', title: 'Hidden', excerpt: '', tags: [] }, { id: 'po3', slug: 'english-only', title: 'English only', excerpt: '', tags: [] }];
    const en = buildSearchIndex({ snapshot, posts: all, integrations: [], locale: 'en', defaultLocale: 'en', locales: ['en', 'nl'] });
    assert.deepEqual(en.entries.filter(e => e.k === 'post').map(e => e.u), ['/blog/hello', '/blog/english-only']);
    const nl = buildSearchIndex({ snapshot, posts: all, integrations: [], locale: 'nl', defaultLocale: 'en', locales: ['en', 'nl'] });
    assert.deepEqual(nl.entries.filter(e => e.k === 'post').map(e => e.u), ['/nl/blog/hello']);
});

test('translated locale: only translated pages, translated title and description, no English-only integrations', () => {
    const { entries } = buildSearchIndex({ snapshot, posts, integrations, locale: 'nl', defaultLocale: 'en', locales: ['en', 'nl'] });
    assert.deepEqual(entries.map(e => e.u), ['/nl/pricing', '/nl/blog/hello']);
    assert.equal(entries[0].t, 'Prijzen');
    assert.equal(entries[0].d, 'Wat het kost');
});

function appWith(snap) {
    const app = express();
    let asked;
    app.use(createSearchIndexRouter({
        getLiveSiteId: async () => 'site1',
        siteLocales: async () => ({ defaultLocale: 'en', locales: ['en', 'nl'] }),
        getSnapshot: async () => snap,
        getPosts: async (_id, o) => { asked = o; return { posts }; },
    }));
    return { app, asked: () => asked };
}

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

test('endpoint serves JSON for the default and a published locale, 404 for the rest', async () => {
    const { app } = appWith(snapshot);
    const ok = await get(app, '/search-index.json');
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(ok.body).locale, 'en');
    const nl = await get(app, '/nl/search-index.json');
    assert.equal(JSON.parse(nl.body).locale, 'nl');
    assert.equal((await get(app, '/en/search-index.json')).status, 404);
    assert.equal((await get(app, '/fr/search-index.json')).status, 404);
    assert.equal((await get(appWith(null).app, '/search-index.json')).status, 404);
});

test('a failing store answers through the error handler (503), never leaks the message', async () => {
    const app = express();
    app.use(createSearchIndexRouter({
        getLiveSiteId: async () => 'site1',
        siteLocales: async () => ({ defaultLocale: 'en', locales: ['en'] }),
        getSnapshot: async () => { throw new Error('db password=hunter2'); },
    }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code }));
    const res = await get(app, '/search-index.json');
    assert.equal(res.status, 503);
    assert.ok(!res.body.includes('hunter2'));
});

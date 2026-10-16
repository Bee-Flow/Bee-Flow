'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSiteRedirect } = require('./siteRedirect');

const snap = (redirects, slugs = []) => ({ redirects, site: { pages: slugs.map((slug) => ({ slug })) } });
const R = (from, to, extra = {}) => ({ from, to, status: 301, external: false, ...extra });

test('no snapshot, no list, no match: null', () => {
    assert.equal(resolveSiteRedirect(null, '/x', ['en']), null);
    assert.equal(resolveSiteRedirect({}, '/x', ['en']), null);
    assert.equal(resolveSiteRedirect(snap([R('/old', '/new')]), '/other', ['en']), null);
});

test('a hit carries the query unless the target has its own', () => {
    const q = new URLSearchParams('utm=1&utm=2');
    assert.deepEqual(resolveSiteRedirect(snap([R('/old', '/new')]), '/old', ['en'], q), { status: 301, location: '/new?utm=1&utm=2' });
    assert.equal(resolveSiteRedirect(snap([R('/old', '/new?a=b')]), '/old', ['en'], q).location, '/new?a=b');
    assert.equal(resolveSiteRedirect(snap([R('/old', '/new#top')]), '/old', ['en'], q).location, '/new?utm=1&utm=2#top');
});

test('the query is never sent to another website', () => {
    const list = [R('/partner', 'https://partner.example/x', { external: true })];
    assert.equal(resolveSiteRedirect(snap(list), '/partner', ['en'], new URLSearchParams('email=x')).location, 'https://partner.example/x');
});

test('a live page at the address (also behind a locale prefix) beats the redirect', () => {
    assert.equal(resolveSiteRedirect(snap([R('/old', '/new')], ['old']), '/old', ['en', 'nl']), null);
    assert.equal(resolveSiteRedirect(snap([R('/old', '/new')], ['old']), '/nl/old', ['en', 'nl']), null);
    assert.equal(resolveSiteRedirect(snap([R('/old', '/new')], ['new']), '/nl/old', ['en', 'nl']).location, '/nl/new');
});

test('the blog index and a published post beat a redirect; an unknown post slug does not', () => {
    const s = { redirects: [R('/blog/old', '/new'), R('/blog/gone', '/new')], site: { pages: [] }, posts: { po_1: { slug: 'old' } } };
    assert.equal(resolveSiteRedirect(s, '/blog/old', ['en']), null);
    assert.equal(resolveSiteRedirect(s, '/nl/blog/old', ['en', 'nl']), null);
    assert.equal(resolveSiteRedirect(s, '/blog/gone', ['en']).location, '/new');
    assert.equal(resolveSiteRedirect({ redirects: [R('/blog', '/new')], site: { pages: [] } }, '/blog', ['en']), null);
});

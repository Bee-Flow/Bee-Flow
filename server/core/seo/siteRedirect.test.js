// @typecheck
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

test('?locale= is applied to a site target here, so the visitor gets one 301 instead of two', () => {
    const site = { defaultLocale: 'en' };
    const s = snap([R('/old', '/new'), R('/home-old', '/'), R('/q', '/new?a=b#top'), R('/app-old', '/app/chat')]);
    /** @param {string} path @param {string} qs @param {object} [opts] */
    const hit = (path, qs, opts = site) => resolveSiteRedirect(s, path, ['en', 'nl'], new URLSearchParams(qs), opts);
    assert.deepEqual(hit('/old', 'locale=nl&utm=1'), { status: 301, location: '/nl/new?utm=1', locale: 'nl' });
    assert.equal(hit('/nl/old', 'locale=en').location, '/new', 'the asked locale wins over the prefix');
    assert.equal(hit('/old', 'locale=NL-be').location, '/nl/new');
    assert.equal(hit('/home-old', 'locale=nl').location, '/nl');
    assert.equal(hit('/q', 'locale=nl&utm=1').location, '/nl/new?a=b#top', 'a target with its own query keeps only that');
    assert.equal(hit('/app-old', 'locale=nl').location, '/app/chat?locale=nl', 'an app path is not a marketing page: left as it was');
    assert.equal(hit('/old', 'locale=de').location, '/new?locale=de', 'a locale the site does not publish is not ours to act on');
    assert.equal(hit('/old', 'locale=nl', {}).location, '/new?locale=nl', 'without the default locale nothing changes');
    // The target page has no Dutch: straight to the default language, not via /nl/new.
    const untranslated = { defaultLocale: 'en', pageLocales: (/** @type {string} */ slug) => (slug === 'new' ? ['en'] : null) };
    assert.deepEqual(hit('/old', 'locale=nl', untranslated), { status: 301, location: '/new', locale: 'nl' });
});

test('?locale= reaches a blog post and an integration page in one hop too, in the language that page has', () => {
    const s = snap([R('/old-post', '/blog/new-post'), R('/old-int', '/integrations/gmail'), R('/old-dir', '/nl/integrations/directory/'), R('/deep', '/integrations/a/b')]);
    /** @type {Record<string, string[]>} */
    const has = { 'blog/new-post': ['en', 'nl'], 'integrations/gmail': ['en'], 'integrations/directory': ['en', 'nl'] };
    const site = { defaultLocale: 'en', pageLocales: (/** @type {string} */ slug) => has[slug] || null };
    /** @param {string} path @param {string} qs */
    const hit = (path, qs) => resolveSiteRedirect(s, path, ['en', 'nl'], new URLSearchParams(qs), site);
    assert.deepEqual(hit('/old-post', 'locale=nl'), { status: 301, location: '/nl/blog/new-post', locale: 'nl' });
    // gmail has no Dutch page: straight to English, not via /nl/integrations/gmail.
    assert.deepEqual(hit('/old-int', 'locale=nl&utm=1'), { status: 301, location: '/integrations/gmail?utm=1', locale: 'nl' });
    assert.equal(hit('/old-dir', 'locale=en').location, '/integrations/directory');
    assert.equal(hit('/old-dir', 'locale=nl').location, '/nl/integrations/directory');
    assert.equal(hit('/deep', 'locale=nl').location, '/integrations/a/b?locale=nl', 'not an integration page address: left as it was');
});

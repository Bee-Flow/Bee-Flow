'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    addRedirect, sanitizeRedirects, renameRedirect, findRedirect, normalizeFrom, normalizeTarget, RedirectError,
} = require('./redirectRules');

const code = (fn) => { try { fn(); } catch (e) { return e instanceof RedirectError ? e.code : `other:${e.message}`; } return null; };

test('normalizeFrom lowercases, adds the slash, drops the trailing one', () => {
    assert.equal(normalizeFrom('Old-Page/'), '/old-page');
    assert.equal(normalizeFrom('/kennis/old'), '/kennis/old');
});

test('normalizeFrom refuses homepage, reserved namespaces, URLs, queries', () => {
    assert.equal(code(() => normalizeFrom('/')), 'from_invalid');
    assert.equal(code(() => normalizeFrom('/app/x')), 'from_reserved');
    assert.equal(code(() => normalizeFrom('/api')), 'from_reserved');
    assert.equal(code(() => normalizeFrom('https://evil.example/x')), 'from_not_a_path');
    assert.equal(code(() => normalizeFrom('//evil.example')), 'from_not_a_path');
    assert.equal(code(() => normalizeFrom('/a?b=1')), 'from_has_query');
    assert.equal(code(() => normalizeFrom('')), 'from_required');
});

test('normalizeTarget accepts site paths and refuses open-redirect shapes', () => {
    assert.deepEqual(normalizeTarget('/new?x=1#top'), { to: '/new?x=1#top', external: false });
    for (const bad of ['//evil.example', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', '/a b', 'evil.example', 'http://evil.example']) {
        assert.ok(code(() => normalizeTarget(bad)), bad);
    }
});

test('external targets need the flag, https and an allowed host', () => {
    const allowed = ['partner.example'];
    assert.equal(code(() => normalizeTarget('https://partner.example/x', { allowedHosts: allowed })), 'to_external_not_confirmed');
    assert.equal(code(() => normalizeTarget('https://other.example/x', { external: true, allowedHosts: allowed })), 'to_host_not_allowed');
    assert.equal(code(() => normalizeTarget('https://partner.example@evil.example/', { external: true, allowedHosts: allowed })), 'to_invalid');
    assert.equal(code(() => normalizeTarget('http://partner.example/x', { external: true, allowedHosts: allowed })), 'to_invalid');
    assert.deepEqual(normalizeTarget('https://partner.example/x', { external: true, allowedHosts: allowed }), { to: 'https://partner.example/x', external: true });
});

test('a redirect cannot point at itself or close a loop', () => {
    assert.equal(code(() => addRedirect([], { from: '/aa', to: '/aa' })), 'loop');
    const one = addRedirect([], { from: '/aa', to: '/bb' });
    assert.equal(code(() => addRedirect(one, { from: '/bb', to: '/aa' })), 'loop');
    const two = addRedirect(one, { from: '/bb', to: '/cc' });
    assert.equal(code(() => addRedirect(two, { from: '/cc', to: '/aa' })), 'loop');
});

test('chains are flattened on write: a -> b, then b -> c makes a -> c', () => {
    let list = addRedirect([], { from: '/aa', to: '/bb' });
    list = addRedirect(list, { from: '/bb', to: '/cc' });
    assert.equal(list.find(r => r.from === '/aa').to, '/cc');
    list = addRedirect(list, { from: '/zz', to: '/aa' });
    assert.equal(list.find(r => r.from === '/zz').to, '/cc');
});

test('same from replaces the entry; status must be 301 or 302', () => {
    let list = addRedirect([], { from: '/aa', to: '/bb' });
    list = addRedirect(list, { from: '/aa', to: '/cc', status: 302 });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 302);
    assert.equal(code(() => addRedirect([], { from: '/aa', to: '/bb', status: 307 })), 'status_invalid');
});

test('sanitizeRedirects drops bad rows and keeps the rest consistent', () => {
    const out = sanitizeRedirects([
        { from: '/aa', to: '/bb' },
        { from: '/bb', to: '/aa' },               // loop: dropped
        { from: '/x', to: '//evil.example' },   // open redirect: dropped
        { from: '/y', to: 'https://evil.example/', external: true }, // host not allowed: dropped
        null,
    ]);
    assert.deepEqual(out.map(r => [r.from, r.to]), [['/aa', '/bb']]);
    assert.deepEqual(sanitizeRedirects('nope'), []);
});

test('renameRedirect describes the 301 for a moved page, null when nothing moved', () => {
    assert.deepEqual(renameRedirect('old', 'new'), { from: '/old', to: '/new', status: 301, auto: true });
    assert.equal(renameRedirect('same', 'same'), null);
});

test('findRedirect matches case-insensitively, ignores a trailing slash, carries the locale prefix', () => {
    const list = addRedirect([], { from: '/old', to: '/new' });
    assert.deepEqual(findRedirect(list, '/Old/', ['en', 'nl']), { status: 301, to: '/new', external: false });
    assert.deepEqual(findRedirect(list, '/nl/old', ['en', 'nl']), { status: 301, to: '/nl/new', external: false });
    assert.equal(findRedirect(list, '/nl/old', ['en']), null);
    assert.equal(findRedirect(list, '/other', ['nl']), null);
    assert.equal(findRedirect(undefined, '/old'), null);
});

test('the locale prefix is not put in front of an application target', () => {
    const list = addRedirect([], { from: '/login-help', to: '/app/help' });
    assert.equal(findRedirect(list, '/nl/login-help', ['nl']).to, '/app/help');
});

test('an external entry is returned as is, without a locale prefix', () => {
    const list = addRedirect([], { from: '/partner', to: 'https://partner.example/x', external: true }, { allowedHosts: ['partner.example'] });
    assert.deepEqual(findRedirect(list, '/nl/partner', ['nl']), { status: 301, to: 'https://partner.example/x', external: true });
});

test('a from that starts with a language prefix is refused, so /x and /nl/x cannot form a loop', () => {
    assert.equal(code(() => addRedirect([], { from: '/nl/aa', to: '/bb' })), 'from_locale_prefix');
    assert.equal(code(() => addRedirect([], { from: '/nl', to: '/bb' })), 'from_locale_prefix');
    assert.equal(code(() => addRedirect([], { from: '/de/aa', to: '/bb' }, { locales: ['de'] })), 'from_locale_prefix');
    // The unprefixed entry already answers /nl/aa; the cycle cannot be built.
    const list = addRedirect([], { from: '/aa', to: '/bb' });
    assert.equal(code(() => addRedirect(list, { from: '/nl/bb', to: '/aa' })), 'from_locale_prefix');
    assert.equal(findRedirect(list, '/nl/aa', ['nl']).to, '/nl/bb');
});

test('the blog index cannot be redirected', () => {
    assert.equal(code(() => addRedirect([], { from: '/blog', to: '/bb' })), 'from_blog');
});

test('targets with dot segments or empty segments are refused', () => {
    for (const bad of ['/./x', '/a/../b', '/a//b', '/..']) assert.ok(code(() => normalizeTarget(bad)), bad);
    assert.deepEqual(normalizeTarget('/a/.hidden'), { to: '/a/.hidden', external: false });
});

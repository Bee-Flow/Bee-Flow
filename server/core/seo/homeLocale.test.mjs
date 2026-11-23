/**
 * Which language a visitor of the bare homepage gets (core/seo/homeLocale.mts).
 *
 * Run: cd server && node --test core/seo/homeLocale.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import {
    preferredLocale, homeLocaleRedirect, siteLocaleCookie, SITE_LOCALE_COOKIE,
} from './homeLocale.mts';

const site = { locales: ['en', 'nl'], defaultLocale: 'en' };

test('the first language by weight wins, region and case ignored', () => {
    assert.strictEqual(preferredLocale('nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7', site.locales), 'nl');
    assert.strictEqual(preferredLocale('en-GB,en;q=0.9,nl;q=0.8', site.locales), 'en');
    assert.strictEqual(preferredLocale('de;q=0.4, NL-BE;q=0.8', site.locales), 'nl');
});

test('a language the site does not offer is skipped, nothing usable gives null', () => {
    assert.strictEqual(preferredLocale('fr-FR,fr;q=0.9,nl;q=0.5', site.locales), 'nl');
    assert.strictEqual(preferredLocale('fr-FR,de;q=0.9', site.locales), null);
    assert.strictEqual(preferredLocale('*', site.locales), null);
    assert.strictEqual(preferredLocale('nl;q=0', site.locales), null, 'q=0 means "not this one"');
    assert.strictEqual(preferredLocale('', site.locales), null);
    assert.strictEqual(preferredLocale(undefined, site.locales), null);
});

test('a Dutch browser on the bare homepage goes to /nl, the query kept', () => {
    const target = homeLocaleRedirect({ path: '/', query: new URLSearchParams('utm_source=news'), acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.8', cookieHeader: '', ...site });
    assert.strictEqual(target, '/nl?utm_source=news');
    assert.strictEqual(homeLocaleRedirect({ path: '/', query: new URLSearchParams(), acceptLanguage: 'nl', cookieHeader: undefined, ...site }), '/nl');
});

test('no redirect for an English browser, a crawler without the header, or another path', () => {
    const base = { query: new URLSearchParams(), cookieHeader: '', ...site };
    assert.strictEqual(homeLocaleRedirect({ ...base, path: '/', acceptLanguage: 'en-US,en;q=0.9' }), null);
    assert.strictEqual(homeLocaleRedirect({ ...base, path: '/', acceptLanguage: undefined }), null);
    assert.strictEqual(homeLocaleRedirect({ ...base, path: '/plans', acceptLanguage: 'nl' }), null);
    assert.strictEqual(homeLocaleRedirect({ ...base, path: '/nl', acceptLanguage: 'nl' }), null);
});

test('a language the visitor chose on the site wins over the browser', () => {
    const base = { path: '/', query: new URLSearchParams(), acceptLanguage: 'nl-NL,nl', ...site };
    assert.strictEqual(homeLocaleRedirect({ ...base, cookieHeader: `theme=dark; ${SITE_LOCALE_COOKIE}=en` }), null);
    assert.strictEqual(homeLocaleRedirect({ ...base, cookieHeader: `${SITE_LOCALE_COOKIE}=nl` }), '/nl');
    // ?locale= in the URL is a choice too: the consolidation redirect handles it.
    assert.strictEqual(homeLocaleRedirect({ ...base, cookieHeader: '', query: new URLSearchParams('locale=en') }), null);
});

test('a site with one language never redirects', () => {
    assert.strictEqual(homeLocaleRedirect({ path: '/', query: new URLSearchParams(), acceptLanguage: 'nl', cookieHeader: '', locales: ['en'], defaultLocale: 'en' }), null);
});

test('the choice cookie is site-wide, a year long, Lax, and only for a known locale', () => {
    const c = siteLocaleCookie('nl', site.locales);
    assert.match(String(c), new RegExp(`^${SITE_LOCALE_COOKIE}=nl;`));
    assert.match(String(c), /Path=\//);
    assert.match(String(c), /Max-Age=31536000/);
    assert.match(String(c), /SameSite=Lax/);
    assert.strictEqual(siteLocaleCookie('fr', site.locales), null);
    assert.strictEqual(siteLocaleCookie('nl;evil=1', site.locales), null);
});

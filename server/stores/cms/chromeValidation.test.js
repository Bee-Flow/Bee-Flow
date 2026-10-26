// @typecheck strict
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateSiteChrome } = require('./chromeValidation');
const { SITE_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');

test('the default chrome is sound', () => {
    assert.strictEqual(validateSiteChrome(JSON.parse(JSON.stringify(SITE_DEFAULTS))), null);
    assert.strictEqual(validateSiteChrome({}), null);
});

test('a footer whose columns is a string is refused with its path (#231)', () => {
    assert.match(String(validateSiteChrome({ footer: { columns: 'x' } })), /footer\.columns must be a list/);
});

test('a header button with a label that is not text and an unknown link kind is refused', () => {
    const bad = { header: { ctas: [{ label: 1, link: { kind: 'bogus' } }] } };
    assert.match(String(validateSiteChrome(bad)), /header\.ctas\[0\]\.label must be text/);
    const kind = { header: { ctas: [{ label: 'Go', link: { kind: 'bogus' } }] } };
    assert.match(String(validateSiteChrome(kind)), /header\.ctas\[0\]\.link\.kind "bogus" is not valid/);
});

test('nested nav, dropdown and footer link mistakes are found', () => {
    assert.match(String(validateSiteChrome({ header: { nav: [{ label: 'A', children: 'x' }] } })), /children must be a list/);
    assert.match(String(validateSiteChrome({ header: { nav: [{ label: 'A', dropdown: { columns: [{ items: [5] }] } }] } })), /items\[0\] must be an object/);
    assert.match(String(validateSiteChrome({ footer: { columns: [{ links: 'x' }] } })), /links must be a list/);
    assert.match(String(validateSiteChrome({ footer: { accountability: { links: {} } } })), /accountability\.links must be a list/);
});

test('a section that is not an object, and banner shape errors, are refused', () => {
    assert.match(String(validateSiteChrome({ footer: 'x' })), /footer must be an object/);
    assert.match(String(validateSiteChrome({ announcement: { enabled: 'yes' } })), /enabled must be true or false/);
    assert.match(String(validateSiteChrome({ cookieBanner: { text: { en: 'hi' } } })), /text\.en must be an object/);
});

test('valid links of every kind pass', () => {
    const ok = { header: { nav: [
        { label: 'A', link: { kind: 'page', pageId: 'pg_1' } },
        { label: 'B', link: { kind: 'external', url: 'https://example.com' } },
        { label: 'C', link: { kind: 'anchor', anchor: 'faq' } },
        { label: 'D', link: { kind: 'app', path: '/app' } },
    ] } };
    assert.strictEqual(validateSiteChrome(ok), null);
});

test('stored footer links are kind-checked through their link object; null logo and accountability count as absent', () => {
    assert.match(String(validateSiteChrome({ footer: { columns: [{ links: [{ label: 'A', link: { kind: 'bogus' } }] }] } })), /link\.kind "bogus"/);
    assert.match(String(validateSiteChrome({ footer: { socials: [{ platform: 'x', link: 5 }] } })), /link must be a link object/);
    assert.strictEqual(validateSiteChrome({ header: { logo: null }, footer: { accountability: null } }), null);
});

test('the cookie banner layout is one of card, bar and corner', () => {
    for (const layout of ['card', 'bar', 'corner']) {
        assert.strictEqual(validateSiteChrome({ cookieBanner: { layout } }), null);
    }
    assert.match(String(validateSiteChrome({ cookieBanner: { layout: 'fullscreen' } })), /cookieBanner\.layout must be one of card, bar, corner/);
    assert.match(String(validateSiteChrome({ cookieBanner: { layout: 3 } })), /cookieBanner\.layout must be one of/);
});

test('the seeded cookie banner keeps today\'s card layout', () => {
    assert.strictEqual(SITE_DEFAULTS.cookieBanner.layout, 'card');
});

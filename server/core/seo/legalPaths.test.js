// @typecheck strict
const test = require('node:test');
const assert = require('node:assert');
const { legalRedirectTarget, LEGAL_DOCS } = require('./legalPaths');
const { parsePublicPath, RESERVED_TOP_LEVEL } = require('./publicPath');

const locales = ['nl'];

test('/legal/<doc> redirects to the single-segment CMS page of that name', () => {
    for (const doc of ['aup', 'cookies', 'dpa', 'imprint', 'subprocessors']) {
        assert.strictEqual(legalRedirectTarget(`/legal/${doc}`, locales, 'en'), `/${doc}`);
    }
});

test('the locale prefix and a trailing slash are kept / dropped sensibly', () => {
    assert.strictEqual(legalRedirectTarget('/nl/legal/dpa/', locales, 'en'), '/nl/dpa');
});

test('unknown documents and other paths are left alone', () => {
    assert.strictEqual(legalRedirectTarget('/legal/whatever', locales, 'en'), null);
    assert.strictEqual(legalRedirectTarget('/legal', locales, 'en'), null);
    assert.strictEqual(legalRedirectTarget('/pricing', locales, 'en'), null);
    assert.strictEqual(legalRedirectTarget('/legal/dpa/extra', locales, 'en'), null);
});

test('every redirect target is a routable marketing path', () => {
    for (const doc of LEGAL_DOCS) {
        const target = legalRedirectTarget(`/legal/${doc}`, locales, 'en');
        assert.ok(parsePublicPath(String(target), locales), `${target} must be a CMS slug`);
    }
});

test('/privacy is a CMS page like any other; the DSR form (/privacy/requests) is unaffected', () => {
    assert.ok(!RESERVED_TOP_LEVEL.has('privacy'));
    assert.deepStrictEqual(parsePublicPath('/privacy', locales), { locale: null, slug: 'privacy' });
    assert.strictEqual(parsePublicPath('/privacy/requests', locales), null);
});

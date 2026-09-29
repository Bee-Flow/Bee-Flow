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
 * are mocked (same harness as routes/cms.public.test.js).
 *
 * Run: node --test stores/cmsStore.announcement.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

const configState = { map: new Map() };
const mockConfigStore = {
    async getConfig(key) { return clone(configState.map.get(key)); },
    async getConfigFresh(key) { return clone(configState.map.get(key)); },
    async setConfig(key, value) { configState.map.set(key, clone(value)); },
    async deleteConfig(key) { configState.map.delete(key); },
    async mutateConfig(key, fn) {
        const cur = configState.map.has(key) ? clone(configState.map.get(key)) : undefined;
        const next = fn(cur);
        configState.map.set(key, clone(next));
        return next;
    },
};

function likeToRegex(pattern) {
    const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${esc.replace(/%/g, '.*').replace(/_/g, '.')}$`);
}
const mockDb = {
    async getAll(sql, params) {
        const keys = [...configState.map.keys()];
        if (/key = \$1 OR key LIKE \$2/.test(sql)) {
            const re = likeToRegex(params[1]);
            return keys.filter((k) => k === params[0] || re.test(k)).map((k) => ({ key: k }));
        }
        const re = likeToRegex(params[0]);
        return keys.filter((k) => re.test(k)).map((k) => ({ key: k }));
    },
};

// Keys are the require strings AS WRITTEN in the module doing the require:
// the store's aggregates live in stores/cms/, one level deeper than the
// cmsStore.js facade, so both spellings of each edge have to be stubbed.
const MOCKS = {
    './configStore': mockConfigStore, '../db': mockDb,
    '../configStore': mockConfigStore, '../../db': mockDb,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

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

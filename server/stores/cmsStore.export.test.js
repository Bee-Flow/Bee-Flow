/**
 * Site export / import — the FULL-website contract.
 *
 * Export v1 shipped the SiteDoc + PageDocs and deliberately left the
 * translations behind ("presentation state, recompute on the destination").
 * The practical effect was that moving a site between installs silently
 * produced an English-only copy: no error, no warning, just pages that had
 * lost every locale. v2 carries them — and carrying them is only half the
 * job, because import regenerates every page id and every block id, while
 * the overrides are keyed by exactly those ids.
 *
 * So the assertions that matter here are the identity hops:
 *   site override  pageTitles : pageId → SLUG → new pageId
 *   page override  blocks     : blockId → (bundle) → new blockId
 * Both are invisible when wrong — the import reports success and the
 * translated page renders in the source language.
 *
 * The store runs REAL on an in-memory config table; only its Postgres edges
 * are mocked (same harness as cmsStore.announcement.test.js).
 *
 * Run: node --test stores/cmsStore.export.test.js
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

// ── Fixture ──────────────────────────────────────────────────────────
//
// One site, two pages, three blocks, translated into Dutch at every layer
// the CMS has: site chrome, page title, block content, page SEO.

const NL_LEAD  = 'De Nederlandse openingszin';
const NL_TITLE = 'Startpagina';
const NL_LOGO  = 'Mijn Website NL';
const NL_META  = 'NL meta titel';

async function buildSourceSite({ withLocales = true } = {}) {
    const { id: siteId } = await cmsStore.createProject({ name: 'Source' });
    const site = await cmsStore.getProject(siteId);
    const homeId = site.pages[0].id;

    // Second page, so pageTitles has something to disambiguate against and
    // the slug→id remap has a real chance to pick the wrong one.
    const { id: aboutId } = await cmsStore.createPage(siteId, { slug: 'about', title: 'About' });

    const home = await cmsStore.getPage(siteId, homeId);
    const hero = cmsStore.makeBlock('hero');
    hero.content.lead = 'The English lead';
    const faq = cmsStore.makeBlock('faq');
    home.blocks = [hero, faq];
    home.seo = { metaTitle: 'EN meta title', metaDescription: '', ogImage: 'cms/1700-og.png', noIndex: false };
    await cmsStore.setPage(siteId, home);

    const about = await cmsStore.getPage(siteId, aboutId);
    about.blocks = [cmsStore.makeBlock('content')];
    await cmsStore.setPage(siteId, about);

    // A logo on the design doc — the other place asset keys hide.
    const siteDoc = await cmsStore.getProject(siteId);
    siteDoc.design = { ...siteDoc.design, logo: 'cms/1700-logo.svg' };
    await cmsStore.setProject(siteId, siteDoc);

    if (withLocales) {
        await cmsStore.setSiteLocaleOverride(siteId, 'nl', {
            header: { logoText: NL_LOGO },
            pageTitles: { [homeId]: NL_TITLE },
        });
        await cmsStore.setPageLocaleOverride(siteId, homeId, 'nl', {
            blocks: { [hero.id]: { content: { lead: NL_LEAD } } },
            seo: { metaTitle: NL_META },
        });
    }

    return { siteId, homeId, aboutId, heroId: hero.id, faqId: faq.id };
}

// ── Export ───────────────────────────────────────────────────────────

test('export v2 carries every locale override, page titles re-keyed by slug', async () => {
    const { siteId, heroId } = await buildSourceSite();
    const bundle = await cmsStore.exportSite(siteId);

    assert.strictEqual(bundle.version, 2, 'bundle version must advertise the locale-carrying format');
    assert.strictEqual(bundle.site.defaultLocale, 'en',
        'without the source locale, the overrides below are ambiguous');
    assert.deepStrictEqual(bundle.site.locales, ['en', 'nl']);

    const chrome = bundle.site.chrome.localeOverrides;
    assert.ok(chrome, 'site-locale overrides must ride along in chrome');
    assert.strictEqual(chrome.nl.header.logoText, NL_LOGO);
    assert.deepStrictEqual(chrome.nl.pageTitles, { home: NL_TITLE },
        'pageTitles must be re-keyed pageId → slug; a raw pageId cannot survive import');

    const home = bundle.site.pages.find(p => p.slug === 'home');
    assert.strictEqual(home.locales.nl.blocks[heroId].content.lead, NL_LEAD,
        'page-locale block overrides stay keyed by block id (the bundle ships those ids)');
    assert.strictEqual(home.locales.nl.seo.metaTitle, NL_META);
});

test('export omits the locale keys entirely for a site with no translations', async () => {
    const { siteId } = await buildSourceSite({ withLocales: false });
    const bundle = await cmsStore.exportSite(siteId);

    assert.deepStrictEqual(bundle.site.locales, ['en']);
    assert.strictEqual(bundle.site.chrome.localeOverrides, undefined,
        'an untranslated site should not grow empty override scaffolding');
    assert.strictEqual(bundle.site.pages[0].locales, undefined);
});

test('collectAssetKeys finds keys wherever they hide in the bundle', async () => {
    const { siteId } = await buildSourceSite();
    const bundle = await cmsStore.exportSite(siteId);
    const keys = cmsStore.collectAssetKeys(bundle);

    assert.ok(keys.has('cms/1700-logo.svg'), 'design.logo');
    assert.ok(keys.has('cms/1700-og.png'), 'seo.ogImage');
});

test('collectAssetKeys accepts both the raw key and the rendered asset URL, and ignores the rest', () => {
    const keys = cmsStore.collectAssetKeys({
        a: 'cms/plain.png',
        b: '/api/cms/asset/cms/via%20url.png',
        c: 'https://example.com/external.png',
        d: '/api/cms/asset/../../etc/passwd',
        e: ['cms/nested.png', { f: 'cms/deep.png' }],
    });
    assert.deepStrictEqual([...keys].sort(),
        ['cms/deep.png', 'cms/nested.png', 'cms/plain.png', 'cms/via url.png']);
});

// ── Import ───────────────────────────────────────────────────────────

test('import restores translations across regenerated page AND block ids', async () => {
    const { siteId } = await buildSourceSite();
    const bundle = await cmsStore.exportSite(siteId);

    const result = await cmsStore.importSite(bundle);
    assert.deepStrictEqual(result.locales, ['nl']);
    assert.deepStrictEqual(result.warnings, []);

    const newSite = await cmsStore.getProject(result.siteId);
    const newHome = newSite.pages.find(p => p.slug === 'home');
    const newDoc = await cmsStore.getPage(result.siteId, newHome.id);
    const newHeroId = newDoc.blocks[0].id;

    assert.notStrictEqual(newHome.id, undefined);
    assert.ok(!bundle.site.pages.some(p => p.blocks.some(b => b.id === newHeroId)),
        'sanity: import must have minted a fresh block id');

    const pageOv = await cmsStore.getPageLocaleOverride(result.siteId, newHome.id, 'nl');
    assert.ok(pageOv, 'page-locale override must exist on the imported site');
    assert.strictEqual(pageOv.blocks[newHeroId].content.lead, NL_LEAD,
        'the override must be re-keyed onto the NEW block id, or the page renders in English');

    const siteOv = await cmsStore.getSiteLocaleOverride(result.siteId, 'nl');
    assert.strictEqual(siteOv.pageTitles[newHome.id], NL_TITLE,
        'pageTitles must be re-keyed slug → NEW page id');

    // End-to-end: what a visitor on ?locale=nl actually gets.
    const eff = await cmsStore.getEffective(result.siteId, '', 'nl');
    assert.strictEqual(eff.page.title, NL_TITLE);
    assert.strictEqual(eff.page.blocks[0].content.lead, NL_LEAD);
    assert.strictEqual(eff.page.seo.metaTitle, NL_META);
    assert.strictEqual(eff.header.logoText, NL_LOGO);

    // …and that the source language is untouched.
    const en = await cmsStore.getEffective(result.siteId, '', 'en');
    assert.strictEqual(en.page.blocks[0].content.lead, 'The English lead');
});

test('a v1 bundle (no locales) still imports — the version ladder, not strict equality', async () => {
    const { siteId } = await buildSourceSite();
    const v2 = await cmsStore.exportSite(siteId);

    // Reconstruct what v1 actually produced: version 1, no defaultLocale,
    // no locales array, no localeOverrides, no page.locales.
    const v1 = {
        _beeflow_export: true,
        version: 1,
        exportedAt: v2.exportedAt,
        site: {
            name: v2.site.name,
            settings: v2.site.settings,
            design: v2.site.design,
            analytics: v2.site.analytics,
            chrome: {
                header: v2.site.chrome.header,
                footer: v2.site.chrome.footer,
                cookieBanner: v2.site.chrome.cookieBanner,
                announcement: v2.site.chrome.announcement,
            },
            pages: v2.site.pages.map(({ locales, ...rest }) => rest),
        },
    };

    const result = await cmsStore.importSite(v1);
    assert.deepStrictEqual(result.locales, [], 'a v1 bundle has no translations to restore');
    const site = await cmsStore.getProject(result.siteId);
    assert.strictEqual(site.pages.length, 2, 'the rest of the v1 payload must import unchanged');
});

test('an unknown bundle version is still rejected', async () => {
    await assert.rejects(
        () => cmsStore.importSite({ _beeflow_export: true, version: 99, site: { pages: [] } }),
        /Unsupported export version: 99/,
    );
    await assert.rejects(
        () => cmsStore.importSite({ version: 2, site: { pages: [] } }),
        /Not a Bee Flow site export/,
    );
});

test('import warns instead of failing when a translation points at a block the export lost', async () => {
    const { siteId, heroId } = await buildSourceSite();
    const bundle = await cmsStore.exportSite(siteId);

    // Simulate a hand-edited / partially-corrupt bundle: the override names a
    // block that isn't in blocks[]. Silently dropping it is how you end up
    // wondering where a translation went.
    const home = bundle.site.pages.find(p => p.slug === 'home');
    home.locales.nl.blocks['blk_deadbeefdeadbeef'] = { content: { lead: 'ghost' } };

    const result = await cmsStore.importSite(bundle);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /1 nl translation\(s\) on \/home/);

    // The good override still landed.
    const newSite = await cmsStore.getProject(result.siteId);
    const newHome = newSite.pages.find(p => p.slug === 'home');
    const doc = await cmsStore.getPage(result.siteId, newHome.id);
    const ov = await cmsStore.getPageLocaleOverride(result.siteId, newHome.id, 'nl');
    assert.strictEqual(ov.blocks[doc.blocks[0].id].content.lead, NL_LEAD);
    assert.ok(heroId);
});

test('import caps the number of locales', async () => {
    const { siteId } = await buildSourceSite();
    const bundle = await cmsStore.exportSite(siteId);
    const overrides = {};
    for (let i = 0; i < 41; i++) overrides[`l${i}`] = { header: { logoText: `x${i}` } };
    bundle.site.chrome.localeOverrides = overrides;

    await assert.rejects(() => cmsStore.importSite(bundle), /Too many locales/);
});

test('import survives a malformed page entry without shifting content onto the wrong page', async () => {
    const { siteId } = await buildSourceSite();
    const bundle = await cmsStore.exportSite(siteId);
    // A junk entry between the two real pages — pagesIn and pagesOut are now
    // misaligned, which is exactly how translations land on the wrong page.
    bundle.site.pages.splice(1, 0, null);

    const result = await cmsStore.importSite(bundle);
    const site = await cmsStore.getProject(result.siteId);
    assert.deepStrictEqual(site.pages.map(p => p.slug), ['home', 'about']);

    const home = site.pages.find(p => p.slug === 'home');
    const doc = await cmsStore.getPage(result.siteId, home.id);
    const ov = await cmsStore.getPageLocaleOverride(result.siteId, home.id, 'nl');
    assert.strictEqual(ov.blocks[doc.blocks[0].id].content.lead, NL_LEAD,
        'the Dutch lead belongs to /home, not to whatever page followed it');
});

// ── Duplicate ────────────────────────────────────────────────────────

test('duplicateProject carries translations too (it had the same silent gap)', async () => {
    const { siteId } = await buildSourceSite();
    const dup = await cmsStore.duplicateProject(siteId);
    const dupId = typeof dup === 'string' ? dup : (dup.id || dup.siteId);

    const eff = await cmsStore.getEffective(dupId, '', 'nl');
    assert.strictEqual(eff.page.blocks[0].content.lead, NL_LEAD,
        'a duplicated site used to arrive English-only');
    assert.strictEqual(eff.page.title, NL_TITLE);
    assert.strictEqual(eff.header.logoText, NL_LOGO);
});

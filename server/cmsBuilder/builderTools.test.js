/**
 * Unit tests for the CMS builder tools (cmsBuilder/builderTools.js).
 *
 * The REAL cmsStore runs (slug dedupe, reserved slugs, sanitizeBlocks alias
 * logic, builder-session trim, locale-override pruning) — only its Postgres
 * edges are mocked via the Module._resolveFilename harness: ./configStore
 * becomes an in-memory map and ../db answers the store's LIKE queries
 * against that map (same pattern as routes/ai/appStudioBuilder.test.js).
 *
 * Run: node --test cmsBuilder/builderTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── In-memory config table + db LIKE queries ────────────────────────

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
    './configStore': mockConfigStore,
    '../db': mockDb,
    '../configStore': mockConfigStore,
    '../../db': mockDb,
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

const cmsStore = require('../stores/cmsStore');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS } = require('../i18n/defaults/cmsDefaults');
const { applyToolCall, MUTATING_TOOLS, SITE_DRAFT_TOOLS, PAGE_DRAFT_TOOLS, MAX_BLOCKS_PER_CALL, NAV_LIMITS, TOOL_SCHEMAS, _test } = require('./builderTools');
const { validateSiteDraft } = require('./validate');

// ── Draft-wrap harness (mirrors what the route assembles per turn) ──

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Test site' });
    const site = await cmsStore.getProject(created.id);
    const pages = new Map();
    for (const entry of site.pages) {
        pages.set(entry.id, await cmsStore.getPage(created.id, entry.id));
    }
    return {
        siteId: created.id,
        userId: 'u1',
        orgId: 'orgA',
        builderSessionId: 'cms_test',
        site,
        pages,
        defaultLocale: 'en',
        locales: [],
        createdPageIds: [],
        touchedPageIds: new Set(),
    };
}

function homeId(draft) { return draft.site.pages[0].id; }

/** Re-read the SiteDoc into the draft (what refreshSite does inside a tool). */
async function refreshDraftSite(draft) {
    draft.site = await cmsStore.getProject(draft.siteId);
}

// ── Pure helpers ────────────────────────────────────────────────────

test('deepMerge: objects merge key-by-key, arrays REPLACE wholesale, null passes through', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, items: [{ t: 'a' }, { t: 'b' }, { t: 'c' }], keep: 'yes' };
    const out = _test.deepMerge(base, { nested: { y: 3 }, items: [{ t: 'only' }], gone: null });
    assert.deepStrictEqual(out.nested, { x: 1, y: 3 });
    assert.deepStrictEqual(out.items, [{ t: 'only' }], 'arrays replace wholesale — never index-merged');
    assert.strictEqual(out.keep, 'yes');
    assert.strictEqual(out.gone, null, 'explicit null is kept (null-sentinel encoding)');
    assert.deepStrictEqual(base.items.length, 3, 'base is not mutated');
});

test('tool bookkeeping sets: 11 mutating tools; page/site draft mappings', () => {
    assert.strictEqual(MUTATING_TOOLS.size, 11);
    assert.ok(SITE_DRAFT_TOOLS.has('cms_create_page') && SITE_DRAFT_TOOLS.has('cms_set_homepage'));
    assert.ok(SITE_DRAFT_TOOLS.has('cms_update_header_nav'), 'nav updates emit a site draft');
    assert.ok(SITE_DRAFT_TOOLS.has('cms_update_design'), 'design updates emit a site draft');
    assert.ok(PAGE_DRAFT_TOOLS.has('cms_add_blocks') && !PAGE_DRAFT_TOOLS.has('cms_reorder_pages'));
    assert.ok(!PAGE_DRAFT_TOOLS.has('cms_update_header_nav'), 'nav touches no page doc');
    assert.ok(!PAGE_DRAFT_TOOLS.has('cms_update_design'), 'design touches no page doc');
    for (const t of [...SITE_DRAFT_TOOLS, ...PAGE_DRAFT_TOOLS]) assert.ok(MUTATING_TOOLS.has(t));
});

// ── Pages ───────────────────────────────────────────────────────────

test('cms_create_page: creates, dedupes duplicate slugs, records createdPageIds', async () => {
    const draft = await makeDraft();
    const r1 = await applyToolCall(draft, 'cms_create_page', { title: 'About us' });
    assert.ok(!r1.error, JSON.stringify(r1));
    assert.match(r1.pageId, /^pg_/);
    assert.strictEqual(r1.slug, 'about-us');
    assert.ok(draft.site.pages.some((p) => p.id === r1.pageId), 'site index refreshed');
    assert.ok(draft.pages.get(r1.pageId), 'PageDoc cached');
    assert.deepStrictEqual(draft.createdPageIds, [r1.pageId]);
    assert.ok(draft.touchedPageIds.has(r1.pageId));

    // Duplicate slug → deduped by the store, not an error.
    const r2 = await applyToolCall(draft, 'cms_create_page', { title: 'About us' });
    assert.ok(!r2.error);
    assert.strictEqual(r2.slug, 'about-us-2');
});

test('cms_create_page: reserved slug → { error, _fixHint }, never a throw', async () => {
    const draft = await makeDraft();
    const r = await applyToolCall(draft, 'cms_create_page', { title: 'Admin', slug: 'admin' });
    assert.ok(r.error, 'reserved slug rejected');
    assert.match(r.error, /reserved/i);
    assert.ok(r._fixHint && /different slug/i.test(r._fixHint), JSON.stringify(r));
    assert.strictEqual(draft.createdPageIds.length, 0);
});

test('cms_update_page_meta: unknown page → hint with known ids; reserved slug rename → error', async () => {
    const draft = await makeDraft();
    const bad = await applyToolCall(draft, 'cms_update_page_meta', { pageId: 'pg_ghost', title: 'X' });
    assert.ok(bad.error && bad._fixHint.includes('Known page ids'), JSON.stringify(bad));

    const home = homeId(draft);
    const reserved = await applyToolCall(draft, 'cms_update_page_meta', { pageId: home, slug: 'privacy' });
    assert.ok(reserved.error && /reserved/i.test(reserved.error), JSON.stringify(reserved));

    const ok = await applyToolCall(draft, 'cms_update_page_meta', { pageId: home, title: 'Start', hideFooter: true });
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.strictEqual(ok.page.title, 'Start');
    assert.strictEqual(ok.page.hideFooter, true);
    assert.strictEqual(draft.pages.get(home).title, 'Start', 'PageDoc cache refreshed');
});

test('cms_update_page_seo: merge semantics + ogImage must be cms/… or absolute URL', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const first = await applyToolCall(draft, 'cms_update_page_seo', { pageId: home, metaTitle: 'Home — Acme' });
    assert.ok(!first.error);
    const invented = await applyToolCall(draft, 'cms_update_page_seo', { pageId: home, ogImage: 'hero-image.png' });
    assert.ok(invented.error, 'invented asset key rejected');
    assert.match(invented._fixHint, /never invent asset keys/i);
    const good = await applyToolCall(draft, 'cms_update_page_seo', { pageId: home, ogImage: 'cms/hero.png', noIndex: true });
    assert.ok(!good.error);
    assert.strictEqual(good.seo.metaTitle, 'Home — Acme', 'earlier field kept (merge, not replace)');
    assert.strictEqual(good.seo.ogImage, 'cms/hero.png');
    assert.strictEqual(good.seo.noIndex, true);
});

// ── Blocks ──────────────────────────────────────────────────────────

test('cms_add_blocks: seeds defaults, deep-merges content, arrays replace wholesale', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [
            { type: 'hero', content: { titleParts: [{ text: 'Fresh bread daily', gradient: true }], lead: 'From our oven.' } },
            { type: 'features' },
        ],
    });
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.blockIds.length, 2);
    assert.deepStrictEqual(r.dropped, []);
    const page = draft.pages.get(home);
    assert.strictEqual(page.blocks.length, 2);
    const hero = page.blocks[0];
    assert.strictEqual(hero.type, 'hero');
    assert.deepStrictEqual(hero.content.titleParts, [{ text: 'Fresh bread daily', gradient: true }], 'array replaced wholesale');
    assert.strictEqual(hero.content.lead, 'From our oven.');
    assert.deepStrictEqual(hero.content.badge, BLOCK_DEFAULTS.hero.badge, 'unspecified defaults seeded');
    assert.strictEqual(page.blocks[1].content.items.length, 3, 'features defaults intact');
});

test('cms_add_blocks: unknown type dropped with _fixHint naming the valid types; aliases warn', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [{ type: 'hero' }, { type: 'banner3000' }, { type: 'stats' }],
    });
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.blockIds.length, 2, 'hero + aliased stats survive');
    assert.deepStrictEqual(r.dropped.map((d) => d.type), ['banner3000']);
    assert.ok(r._fixHint.includes('Valid block types'), r._fixHint);
    for (const t of BLOCK_TYPE_IDS) assert.ok(r._fixHint.includes(t), `fix hint lists ${t}`);
    assert.ok(r.warnings.some((w) => w.includes('"stats"') && w.includes('"techStats"')), JSON.stringify(r.warnings));
    assert.strictEqual(draft.pages.get(home).blocks[1].type, 'techStats');
});

test('cms_add_blocks: all types unknown → { error, _fixHint }, nothing persisted', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const r = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'nope' }, { type: 'zilch' }] });
    assert.ok(r.error && r._fixHint, JSON.stringify(r));
    assert.strictEqual(r.dropped.length, 2);
    assert.strictEqual(draft.pages.get(home).blocks.length, 0);
});

test('cms_add_blocks: batch cap 10', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: Array.from({ length: MAX_BLOCKS_PER_CALL + 1 }, () => ({ type: 'cta' })),
    });
    assert.ok(r.error && r.error.includes(`max ${MAX_BLOCKS_PER_CALL}`), JSON.stringify(r));
});

test('cms_add_blocks: position end / afterBlockId / index; unknown afterBlockId errors with ids', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const first = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'hero' }, { type: 'cta' }] });
    const [heroId, ctaId] = first.blockIds;

    // {afterBlockId} — insert right after the hero.
    const mid = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'features' }], position: { afterBlockId: heroId } });
    assert.ok(!mid.error, JSON.stringify(mid));
    // {index:0} — insert at the very top.
    const top = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'socialProof' }], position: { index: 0 } });
    assert.ok(!top.error);
    // default 'end'.
    const tail = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'steps' }], position: 'end' });
    assert.ok(!tail.error);

    const types = draft.pages.get(home).blocks.map((b) => b.type);
    assert.deepStrictEqual(types, ['socialProof', 'hero', 'features', 'cta', 'steps'], types.join(','));
    assert.strictEqual(draft.pages.get(home).blocks[3].id, ctaId);

    const bad = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'cta' }], position: { afterBlockId: 'blk_ghost' } });
    assert.ok(bad.error && bad._fixHint.includes(heroId), JSON.stringify(bad));
});

test('cms_update_block: content deep-merge (arrays wholesale), style enums validated, enabled toggle', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const added = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'features' }] });
    const blockId = added.blockIds[0];

    // Array replaces wholesale — one item wipes the three defaults.
    const patched = await applyToolCall(draft, 'cms_update_block', {
        pageId: home, blockId,
        contentPatch: { title: 'Why us', items: [{ icon: 'Star', title: 'Only one', body: 'x', techTag: '' }] },
    });
    assert.ok(!patched.error, JSON.stringify(patched));
    const block = draft.pages.get(home).blocks[0];
    assert.strictEqual(block.content.title, 'Why us');
    assert.strictEqual(block.content.items.length, 1, 'items array replaced wholesale');
    assert.strictEqual(block.content.eyebrow, BLOCK_DEFAULTS.features.eyebrow, 'unpatched keys kept');

    // Bad enum → error listing valid values.
    const badEnum = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId, stylePatch: { maxWidth: 'huge' } });
    assert.ok(badEnum.error, JSON.stringify(badEnum));
    assert.match(badEnum._fixHint, /narrow, medium, wide, full/);

    // Valid style + unknown color token → applied with a repair hint.
    const styled = await applyToolCall(draft, 'cms_update_block', {
        pageId: home, blockId,
        stylePatch: { maxWidth: 'wide', align: 'center', colorOverrides: { primary: '#112233', bogus: '#fff' }, spacing: { paddingTop: 32 } },
        enabled: false,
    });
    assert.ok(!styled.error, JSON.stringify(styled));
    assert.ok(styled._hints.some((h) => h.includes('bogus')), JSON.stringify(styled._hints));
    const saved = draft.pages.get(home).blocks[0];
    assert.strictEqual(saved.style.maxWidth, 'wide');
    assert.strictEqual(saved.style.align, 'center');
    assert.deepStrictEqual(saved.style.colorOverrides, { primary: '#112233' });
    assert.deepStrictEqual(saved.style.spacing, { paddingTop: 32 });
    assert.strictEqual(saved.enabled, false);
    assert.strictEqual(styled.enabled, false);

    // Unknown block id → hint with real ids.
    const missing = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId: 'blk_ghost', enabled: true });
    assert.ok(missing.error && missing._fixHint.includes(blockId), JSON.stringify(missing));
});

test('cms_remove_block: prunes the locale override for EVERY locale, keeps other blocks’ overrides', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const added = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'hero' }, { type: 'cta' }] });
    const [heroId, ctaId] = added.blockIds;

    await cmsStore.setPageLocaleOverride(draft.siteId, home, 'nl', {
        blocks: {
            [heroId]: { content: { lead: 'NL lead' } },
            [ctaId]: { content: { title: 'NL cta' } },
        },
    });
    await cmsStore.setPageLocaleOverride(draft.siteId, home, 'de', {
        blocks: { [heroId]: { content: { lead: 'DE lead' } } },
    });

    const r = await applyToolCall(draft, 'cms_remove_block', { pageId: home, blockId: heroId });
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.removed, heroId);
    assert.deepStrictEqual([...r.prunedLocales].sort(), ['de', 'nl'], 'both locales pruned');

    const nl = await cmsStore.getPageLocaleOverride(draft.siteId, home, 'nl');
    assert.strictEqual(nl.blocks[heroId], undefined, 'removed block’s nl override gone');
    assert.ok(nl.blocks[ctaId], 'other block’s override untouched');
    const de = await cmsStore.getPageLocaleOverride(draft.siteId, home, 'de');
    assert.strictEqual(de.blocks[heroId], undefined, 'removed block’s de override gone');

    assert.deepStrictEqual(draft.pages.get(home).blocks.map((b) => b.id), [ctaId]);
});

test('cms_reorder_blocks: set-equality enforced (missing/extra listed), then reorders', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const added = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'hero' }, { type: 'features' }, { type: 'cta' }] });
    const [a, b, c] = added.blockIds;

    const missing = await applyToolCall(draft, 'cms_reorder_blocks', { pageId: home, orderedBlockIds: [c, a] });
    assert.ok(missing.error && missing.error.includes(`missing: ${b}`), JSON.stringify(missing));
    const extra = await applyToolCall(draft, 'cms_reorder_blocks', { pageId: home, orderedBlockIds: [c, a, b, 'blk_ghost'] });
    assert.ok(extra.error && extra.error.includes('blk_ghost'), JSON.stringify(extra));
    const dupes = await applyToolCall(draft, 'cms_reorder_blocks', { pageId: home, orderedBlockIds: [c, a, a] });
    assert.ok(dupes.error, JSON.stringify(dupes));

    const ok = await applyToolCall(draft, 'cms_reorder_blocks', { pageId: home, orderedBlockIds: [c, a, b] });
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.deepStrictEqual(draft.pages.get(home).blocks.map((x) => x.id), [c, a, b]);
});

// ── Site-index tools ────────────────────────────────────────────────

test('cms_set_homepage + cms_reorder_pages: validate ids, refresh the site index', async () => {
    const draft = await makeDraft();
    const about = await applyToolCall(draft, 'cms_create_page', { title: 'About' });
    const contact = await applyToolCall(draft, 'cms_create_page', { title: 'Contact' });
    const home = draft.site.pages.find((p) => p.slug === 'home').id;

    const badHome = await applyToolCall(draft, 'cms_set_homepage', { pageId: 'pg_ghost' });
    assert.ok(badHome.error && badHome._fixHint.includes('Known page ids'), JSON.stringify(badHome));
    const setHome = await applyToolCall(draft, 'cms_set_homepage', { pageId: about.pageId });
    assert.ok(!setHome.error);
    assert.strictEqual(draft.site.homepageId, about.pageId);
    assert.ok(draft.site.pages.find((p) => p.id === about.pageId).isHomepage);

    const badOrder = await applyToolCall(draft, 'cms_reorder_pages', { orderedIds: [contact.pageId, about.pageId] });
    assert.ok(badOrder.error && badOrder.error.includes(`missing: ${home}`), JSON.stringify(badOrder));
    const order = await applyToolCall(draft, 'cms_reorder_pages', { orderedIds: [contact.pageId, home, about.pageId] });
    assert.ok(!order.error, JSON.stringify(order));
    assert.deepStrictEqual(draft.site.pages.map((p) => p.id), [contact.pageId, home, about.pageId]);
});

// ── Header nav (cms_update_header_nav) ──────────────────────────────

test('cms_update_header_nav: schema in the roster; wholesale replace persists through the real store', async () => {
    const schema = TOOL_SCHEMAS.find((s) => s.function.name === 'cms_update_header_nav');
    assert.ok(schema, 'schema registered');
    assert.deepStrictEqual(schema.function.parameters.required, ['nav']);
    assert.match(schema.function.description, /WHOLESALE/i, 'schema teaches wholesale replacement');

    const draft = await makeDraft();
    const home = homeId(draft);
    const about = await applyToolCall(draft, 'cms_create_page', { title: 'About' });

    const r = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [
            { id: 'nav_keep0001', label: '  Home  ', link: { kind: 'page', pageId: home } },
            {
                label: 'Company',
                link: { kind: 'anchor', anchor: 'top' },
                children: [{ label: 'About', link: { kind: 'page', pageId: about.pageId } }],
            },
            {
                label: 'Product',
                link: { kind: 'external', url: 'https://example.com', newTab: true },
                dropdown: {
                    layout: 'list',   // normalized → 'columns' (see below)
                    columns: [{
                        heading: 'Features',
                        items: [{ label: 'App', link: { kind: 'app', path: '/app' }, description: 'Open the app', icon: '🚀', openInNewTab: false }],
                    }],
                },
            },
        ],
    });
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.navCount, 3);
    assert.deepStrictEqual(r.labels, ['Home', 'Company', 'Product']);

    // Draft refreshed via refreshSite: ids preserved/minted, extras kept.
    const nav = draft.site.header.nav;
    assert.strictEqual(nav.length, 3);
    assert.strictEqual(nav[0].id, 'nav_keep0001', 'existing id preserved');
    assert.strictEqual(nav[0].label, 'Home', 'label trimmed');
    assert.match(nav[1].id, /^nav_/, 'missing top-level id minted with nav_');
    assert.match(nav[1].children[0].id, /^nav_/, 'missing child id minted with nav_');
    // Column data ONLY renders under layout 'columns' (Header.jsx readDropdown,
    // synthesizeLegacyContent, the admin preview) — a persisted 'list' layout
    // would store the columns and then silently render nothing.
    assert.strictEqual(nav[2].dropdown.layout, 'columns', "'list' normalized to the only renderable layout");
    assert.match(nav[2].dropdown.columns[0].id, /^nav_/, 'missing column id minted with nav_');
    assert.strictEqual(nav[2].dropdown.columns[0].items[0].icon, '🚀', 'emoji icon kept (mega items are not Lucide)');
    assert.strictEqual(nav[2].dropdown.columns[0].items[0].openInNewTab, false);

    // Persisted verbatim through the real cmsStore.setProject.
    const stored = await cmsStore.getProject(draft.siteId);
    assert.deepStrictEqual(stored.header.nav, nav, 'store round-trips the sanitized nav');
    assert.strictEqual(stored.header.logoText, 'My Website', 'rest of the header untouched');

    // A second call REPLACES wholesale — nothing merged.
    const r2 = await applyToolCall(draft, 'cms_update_header_nav', { nav: [{ label: 'Only', link: { kind: 'page', pageId: home } }] });
    assert.ok(!r2.error, JSON.stringify(r2));
    assert.deepStrictEqual(draft.site.header.nav.map((i) => i.label), ['Only']);
});

test('cms_update_header_nav: re-reads before writing — a concurrent admin edit is not reverted', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);

    // draftWrap.site is loaded once at turn start and setProject rewrites the
    // WHOLE doc with no CAS. Simulate the real race: another admin (or another
    // builder session — sessions are site-scoped and shared) mutates the site
    // AFTER the turn started but BEFORE the model calls this tool.
    const concurrent = await cmsStore.getProject(draft.siteId);
    concurrent.name = 'Renamed by admin B';
    concurrent.analytics = { gaMeasurementId: 'G-CONCUR01' };
    await cmsStore.setProject(draft.siteId, concurrent);
    const newPage = await cmsStore.createPage(draft.siteId, { title: 'Made by admin B' });

    // The stale draftWrap.site still has the old name and no new page.
    assert.notStrictEqual(draft.site.name, 'Renamed by admin B', 'precondition: draft copy is stale');

    const r = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{ label: 'Home', link: { kind: 'page', pageId: home } }],
    });
    assert.ok(!r.error, JSON.stringify(r));

    const stored = await cmsStore.getProject(draft.siteId);
    assert.deepStrictEqual(stored.header.nav.map((i) => i.label), ['Home'], 'nav applied');
    assert.strictEqual(stored.name, 'Renamed by admin B', "concurrent rename NOT reverted");
    assert.strictEqual(stored.analytics.gaMeasurementId, 'G-CONCUR01', 'concurrent analytics edit NOT reverted');
    assert.ok(
        stored.pages.some((p) => p.id === newPage.id),
        'page created mid-turn NOT dropped from the index (would orphan its PageDoc)',
    );
});

test('cms_update_header_nav: teaching-signal rejections; nothing persists on a rejected call', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);

    const notArray = await applyToolCall(draft, 'cms_update_header_nav', { nav: 'Home, About' });
    assert.ok(notArray.error && /must be an array/i.test(notArray.error), JSON.stringify(notArray));
    assert.match(notArray._fixHint, /kind/i, 'fix hint teaches the link union');

    const emptyLabel = await applyToolCall(draft, 'cms_update_header_nav', { nav: [{ label: '   ', link: { kind: 'anchor', anchor: 'x' } }] });
    assert.ok(emptyLabel.error && emptyLabel.error.includes('nav[0].label'), JSON.stringify(emptyLabel));

    const badKind = await applyToolCall(draft, 'cms_update_header_nav', { nav: [{ label: 'Mail', link: { kind: 'mailto', url: 'mailto:x@y.z' } }] });
    assert.ok(badKind.error && badKind.error.includes('nav[0].link.kind'), JSON.stringify(badKind));
    assert.ok(badKind._fixHint.includes('page') && badKind._fixHint.includes('external'), badKind._fixHint);

    const ghost = await applyToolCall(draft, 'cms_update_header_nav', { nav: [{ label: 'Ghost', link: { kind: 'page', pageId: 'pg_ghost' } }] });
    assert.ok(ghost.error && ghost.error.includes('pg_ghost'), JSON.stringify(ghost));
    assert.ok(ghost._fixHint.includes('Known page ids') && ghost._fixHint.includes(home), 'pageIdsHint attached');

    // A bad child deep inside an otherwise-fine call rejects the WHOLE call
    // with the exact path (wholesale semantics: no partial nav writes).
    const badChild = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{ label: 'Top', link: { kind: 'anchor', anchor: 'a' }, children: [{ label: 'Sub', link: { kind: 'page', pageId: 'pg_nope' } }] }],
    });
    assert.ok(badChild.error && badChild.error.includes('nav[0].children[0]'), JSON.stringify(badChild));

    const stored = await cmsStore.getProject(draft.siteId);
    assert.deepStrictEqual(stored.header.nav, [], 'no rejected call ever persisted');
});

test('cms_update_header_nav: caps — 20 top-level, 10 children, 4 columns, 10 items/column', async () => {
    const draft = await makeDraft();
    const item = (label) => ({ label, link: { kind: 'anchor', anchor: 'x' } });

    const tooMany = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: Array.from({ length: NAV_LIMITS.topLevel + 1 }, (_, i) => item(`L${i}`)),
    });
    assert.ok(tooMany.error && tooMany.error.includes(`max ${NAV_LIMITS.topLevel}`), JSON.stringify(tooMany));

    const tooManyChildren = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{ ...item('Top'), children: Array.from({ length: NAV_LIMITS.children + 1 }, (_, i) => item(`C${i}`)) }],
    });
    assert.ok(tooManyChildren.error && tooManyChildren.error.includes(`max ${NAV_LIMITS.children}`), JSON.stringify(tooManyChildren));

    const tooManyCols = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{ ...item('Top'), dropdown: { layout: 'columns', columns: Array.from({ length: NAV_LIMITS.columns + 1 }, () => ({ heading: 'H', items: [item('X')] })) } }],
    });
    assert.ok(tooManyCols.error && tooManyCols.error.includes(`max ${NAV_LIMITS.columns}`), JSON.stringify(tooManyCols));

    const tooManyColItems = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{ ...item('Top'), dropdown: { layout: 'columns', columns: [{ heading: 'H', items: Array.from({ length: NAV_LIMITS.columnItems + 1 }, (_, i) => item(`M${i}`)) }] } }],
    });
    assert.ok(tooManyColItems.error && tooManyColItems.error.includes(`max ${NAV_LIMITS.columnItems}`), JSON.stringify(tooManyColItems));

    // Exactly at the top-level cap is fine.
    const atCap = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: Array.from({ length: NAV_LIMITS.topLevel }, (_, i) => item(`L${i}`)),
    });
    assert.ok(!atCap.error, JSON.stringify(atCap));
    assert.strictEqual(atCap.navCount, NAV_LIMITS.topLevel);
});

test('cms_update_header_nav: unknown keys stripped at every level; dropdown.layout sanitized', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    const r = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{
            label: 'Top', link: { kind: 'page', pageId: home },
            bogus: 'dropped', style: { color: 'red' },
            children: [{ label: 'Sub', link: { kind: 'anchor', anchor: 'a' }, tracking: 'utm' }],
            dropdown: {
                layout: 'mega-wide', evil: true,
                columns: [{
                    heading: 'H', legacy: 1,
                    items: [{ label: 'Mi', link: { kind: 'app', path: '/app' }, icon: '⚡', openInNewTab: 'yes', onClick: 'alert(1)' }],
                }],
            },
        }],
    });
    assert.ok(!r.error, JSON.stringify(r));
    const item = draft.site.header.nav[0];
    assert.deepStrictEqual(Object.keys(item).sort(), ['children', 'dropdown', 'id', 'label', 'link'], 'top-level whitelist');
    assert.deepStrictEqual(Object.keys(item.children[0]).sort(), ['id', 'label', 'link'], 'child whitelist');
    assert.strictEqual(item.dropdown.layout, 'columns', 'unknown layout sanitized to the default');
    assert.deepStrictEqual(Object.keys(item.dropdown).sort(), ['columns', 'layout'], 'dropdown whitelist');
    const col = item.dropdown.columns[0];
    assert.deepStrictEqual(Object.keys(col).sort(), ['heading', 'id', 'items'], 'column whitelist');
    const mi = col.items[0];
    assert.deepStrictEqual(Object.keys(mi).sort(), ['icon', 'id', 'label', 'link'], 'mega-item whitelist');
    assert.strictEqual(mi.icon, '⚡');
    assert.ok(!('openInNewTab' in mi), 'non-boolean openInNewTab dropped');
});

// ── Design (cms_update_design) ──────────────────────────────────────

const { THEME_PRESETS, THEME_PRESET_IDS } = require('../i18n/defaults/themePresets');
const { DESIGN_FONTS } = require('../i18n/defaults/cmsDefaults');

/**
 * Raw poke at the persisted SiteDoc, bypassing cmsStore.setProject's
 * sanitizer — the only way to simulate legacy/imported design data (the
 * store would strip it on the way in). Returns the raw doc for assertions.
 */
function rawSiteDoc(siteId) {
    for (const value of configState.map.values()) {
        if (value && value.id === siteId && Array.isArray(value.pages) && value.design) return value;
    }
    throw new Error(`no stored SiteDoc for ${siteId}`);
}

test('cms_update_design: schema in the roster; deep-merge patch persists through the real store', async () => {
    const schema = TOOL_SCHEMAS.find((s) => s.function.name === 'cms_update_design');
    assert.ok(schema, 'schema registered');
    assert.strictEqual(TOOL_SCHEMAS.length, 13, 'CLOSED SET — 13 tools');
    assert.ok(!schema.function.parameters.required, 'every field is optional (it is a patch)');
    assert.match(schema.function.description, /DEEP-MERGE PATCH/i, 'schema teaches patch semantics');
    // logo/favicon are uploaded asset keys — never settable by the model.
    const props = Object.keys(schema.function.parameters.properties).sort();
    assert.deepStrictEqual(props, [
        'colorsPatch', 'componentsPatch', 'darkColorsPatch', 'fontsPatch', 'gradient',
        'grain', 'layoutPatch', 'motion', 'preset', 'radius', 'theme', 'typographyPatch',
    ], props.join(','));
    assert.deepStrictEqual(schema.function.parameters.properties.preset.enum, THEME_PRESET_IDS);

    const draft = await makeDraft();
    const before = clone(draft.site.design);

    const r = await applyToolCall(draft, 'cms_update_design', {
        colorsPatch: { primary: '#0B5CD5' },
        fontsPatch: { heading: 'Manrope' },
        componentsPatch: { buttonShape: 'pill' },
        layoutPatch: { containerWidth: 'wide' },
        typographyPatch: { bodySize: 17 },
        radius: 6,
        theme: 'dark',
        motion: 'subtle',
        grain: true,
    });
    assert.ok(!r.error, JSON.stringify(r));

    // PATCH, not replace: untouched siblings inside each group survive.
    const d = draft.site.design;
    assert.strictEqual(d.colors.primary, '#0B5CD5');
    assert.strictEqual(d.colors.accent, before.colors.accent, 'other colours untouched');
    assert.strictEqual(d.colors.textPrimary, before.colors.textPrimary);
    assert.strictEqual(d.fonts.heading, 'Manrope');
    assert.strictEqual(d.fonts.body, before.fonts.body, 'other font roles untouched');
    assert.strictEqual(d.components.buttonShape, 'pill');
    assert.strictEqual(d.components.cardStyle, before.components.cardStyle, 'other components untouched');
    assert.strictEqual(d.layout.containerWidth, 'wide');
    assert.strictEqual(d.layout.sectionRhythm, before.layout.sectionRhythm);
    assert.strictEqual(d.typography.bodySize, 17);
    assert.strictEqual(d.typography.displaySize, before.typography.displaySize);
    assert.strictEqual(d.radius, 6);
    assert.strictEqual(d.theme, 'dark');
    assert.strictEqual(d.motion, 'subtle');
    assert.strictEqual(d.grain, true);
    assert.strictEqual(d.gradient, before.gradient, 'unsent booleans untouched');

    // Persisted through the real cmsStore.setProject; result mirrors it.
    const stored = await cmsStore.getProject(draft.siteId);
    assert.deepStrictEqual(stored.design, d, 'store round-trips the design');
    assert.deepStrictEqual(r.design, d, 'result carries the persisted design');
    assert.ok(r.summary.includes('primary #0B5CD5') && r.summary.includes('container wide'), r.summary);
    assert.strictEqual(stored.name, 'Test site', 'rest of the SiteDoc untouched');
});

test('cms_update_design: preset materializes the whole theme, then patches layer on top', async () => {
    const draft = await makeDraft();
    const midnight = THEME_PRESETS.find((p) => p.id === 'midnight-flow');

    const r = await applyToolCall(draft, 'cms_update_design', {
        preset: 'midnight-flow',
        colorsPatch: { primary: '#FF0055' },
    });
    assert.ok(!r.error, JSON.stringify(r));
    const d = draft.site.design;
    assert.strictEqual(d.preset, 'midnight-flow', 'preset id recorded (drives the Active badge)');
    assert.strictEqual(d.colors.primary, '#FF0055', 'the explicit patch beats the preset');
    assert.strictEqual(d.colors.background, midnight.design.colors.background, 'preset values materialized');
    assert.deepStrictEqual(d.fonts, midnight.design.fonts);
    assert.deepStrictEqual(d.components, midnight.design.components, 'components group replaced wholesale');
    assert.deepStrictEqual(d.layout, midnight.design.layout);
    assert.strictEqual(d.radius, midnight.design.radius);
    // Uploaded assets are never touched by a theme change.
    assert.strictEqual(d.logo, '');
    assert.strictEqual(d.favicon, '');
    assert.ok(r.summary.includes('preset midnight-flow'), r.summary);
});

test('cms_update_design: re-reads before writing — a concurrent admin edit is not reverted', async () => {
    const draft = await makeDraft();

    // draftWrap.site is loaded once at turn start and setProject rewrites the
    // WHOLE doc with no CAS. Simulate the real race: another admin (or another
    // builder session — sessions are site-scoped and shared) mutates the site
    // AFTER the turn started but BEFORE the model calls this tool.
    const concurrent = await cmsStore.getProject(draft.siteId);
    concurrent.name = 'Renamed by admin B';
    concurrent.analytics = { gaMeasurementId: 'G-CONCUR02' };
    concurrent.design = { ...concurrent.design, fonts: { ...concurrent.design.fonts, mono: 'JetBrains Mono' } };
    await cmsStore.setProject(draft.siteId, concurrent);
    const newPage = await cmsStore.createPage(draft.siteId, { title: 'Made by admin B' });

    assert.notStrictEqual(draft.site.name, 'Renamed by admin B', 'precondition: draft copy is stale');
    assert.notStrictEqual(draft.site.design.fonts.mono, 'JetBrains Mono', 'precondition: stale design too');

    const r = await applyToolCall(draft, 'cms_update_design', { colorsPatch: { primary: '#123456' } });
    assert.ok(!r.error, JSON.stringify(r));

    const stored = await cmsStore.getProject(draft.siteId);
    assert.strictEqual(stored.design.colors.primary, '#123456', 'design patch applied');
    assert.strictEqual(stored.design.fonts.mono, 'JetBrains Mono', "concurrent DESIGN edit NOT reverted");
    assert.strictEqual(stored.name, 'Renamed by admin B', 'concurrent rename NOT reverted');
    assert.strictEqual(stored.analytics.gaMeasurementId, 'G-CONCUR02', 'concurrent analytics edit NOT reverted');
    assert.ok(
        stored.pages.some((p) => p.id === newPage.id),
        'page created mid-turn NOT dropped from the index (would orphan its PageDoc)',
    );
});

test('cms_update_design: teaching-signal rejections; nothing persists on a rejected call', async () => {
    const draft = await makeDraft();
    const before = clone(draft.site.design);
    const { DESIGN_HINT } = require('./schemas');

    const cases = [
        ['bad hex', { colorsPatch: { primary: 'warm amber' } }, /#rrggbb/i],
        ['3-digit shorthand', { colorsPatch: { primary: '#f5a' } }, /#rrggbb/i],
        ['unknown colour key', { colorsPatch: { tertiary: '#123456' } }, /not a colour/i],
        ['blank light colour', { colorsPatch: { primary: '' } }, /#rrggbb/i],
        ['unknown font', { fontsPatch: { heading: 'Comic Papyrus' } }, /not an available font/i],
        ['unknown font role', { fontsPatch: { display: 'Inter' } }, /not a font role/i],
        ['radius 32', { radius: 32 }, /0 to 24/],
        ['radius negative', { radius: -1 }, /0 to 24/],
        ['radius string', { radius: '12' }, /0 to 24/],
        ['unknown component enum', { componentsPatch: { buttonShape: 'squircle' } }, /not a legal value/i],
        ['unknown component key', { componentsPatch: { buttonGlow: 'on' } }, /not a field/i],
        ['unknown layout enum', { layoutPatch: { containerWidth: 'gigantic' } }, /not a legal value/i],
        ['unknown typography value', { typographyPatch: { headingWeight: 800 } }, /not a legal value/i],
        ['unknown theme', { theme: 'sepia' }, /invalid/i],
        ['unknown motion', { motion: 'wild' }, /invalid/i],
        ['non-boolean grain', { grain: 'yes' }, /true or false/],
        ['unknown preset', { preset: 'retro-hive' }, /not a built-in theme/i],
        ['empty call', {}, /Nothing to change/i],
    ];
    for (const [name, args, re] of cases) {
        const r = await applyToolCall(draft, 'cms_update_design', args);
        assert.ok(r.error, `${name}: expected a rejection, got ${JSON.stringify(r)}`);
        assert.match(r.error, re, name);
        assert.strictEqual(r._fixHint, DESIGN_HINT, `${name}: carries the design fix hint`);
    }
    // The fix hint actually teaches the vocabulary the model needs.
    assert.ok(DESIGN_HINT.includes('#rrggbb') && DESIGN_HINT.includes('0-24'), DESIGN_HINT);
    for (const font of DESIGN_FONTS) assert.ok(DESIGN_HINT.includes(font), `fix hint lists ${font}`);
    for (const id of THEME_PRESET_IDS) assert.ok(DESIGN_HINT.includes(id), `fix hint lists ${id}`);

    // Rejections are pre-I/O: not one of them touched the store.
    const stored = await cmsStore.getProject(draft.siteId);
    assert.deepStrictEqual(stored.design, before, 'no rejected call ever persisted');
    assert.deepStrictEqual(draft.site.design, before);

    // darkColors.primary/accent DO accept '' — "reuse the light value".
    const blankOk = await applyToolCall(draft, 'cms_update_design', { darkColorsPatch: { primary: '', accent: '' } });
    assert.ok(!blankOk.error, JSON.stringify(blankOk));
    const blankBad = await applyToolCall(draft, 'cms_update_design', { darkColorsPatch: { background: '' } });
    assert.ok(blankBad.error && /#rrggbb/i.test(blankBad.error), JSON.stringify(blankBad));
});

test('cms_update_design: the summary reports what was PERSISTED, not what was requested', async () => {
    const draft = await makeDraft();

    // Legacy/imported design data that sanitizeDesign SILENTLY drops or
    // coerces (it never rejects). Poked in raw, because setProject would
    // have scrubbed it on the way in.
    const raw = rawSiteDoc(draft.siteId);
    raw.design.preset = 'retro-hive';          // not a real preset → 'custom'
    raw.design.legacyGlow = true;              // unknown key → dropped
    raw.design.colors.tertiary = '#123456';    // unknown colour → dropped
    raw.design.components.buttonShape = 'squircle'; // unknown enum → identity 'soft'
    raw.design.radius = 999;                   // out of range → back to the default
    await refreshDraftSite(draft);

    const r = await applyToolCall(draft, 'cms_update_design', { colorsPatch: { primary: '#0B5CD5' } });
    assert.ok(!r.error, JSON.stringify(r));

    // Everything the tool merged forward from the stale doc was scrubbed by
    // the store — and the RESULT reflects the scrubbed doc, so the model is
    // never told an edit landed that actually evaporated.
    const stored = await cmsStore.getProject(draft.siteId);
    assert.deepStrictEqual(r.design, stored.design, 'result === persisted doc');
    assert.strictEqual(r.design.preset, 'custom', "bogus preset coerced, and reported as coerced");
    assert.ok(!('legacyGlow' in r.design), 'unknown key dropped by the store and absent from the result');
    assert.ok(!('tertiary' in r.design.colors), 'unknown colour dropped');
    assert.strictEqual(r.design.components.buttonShape, 'soft', 'unknown enum fell back to the identity value');
    assert.strictEqual(r.design.radius, 12, 'out-of-range radius reset to the default');
    assert.strictEqual(r.design.colors.primary, '#0B5CD5', 'the actual edit landed');
    assert.ok(r.summary.includes('preset custom'), r.summary);
    assert.ok(!r.summary.includes('retro-hive') && !r.summary.includes('squircle'), r.summary);
    assert.strictEqual(r.summary, _test.summariseDesign(stored.design));
});

test('validateSiteDraft: design warnings (bad_color, unknown_font, low_contrast) are never errors', async () => {
    const draft = await makeDraft();
    // The shipped default palette is well-formed…
    const clean = validateSiteDraft(draft);
    assert.ok(!clean.warnings.some((w) => ['bad_color', 'unknown_font'].includes(w.code)), JSON.stringify(clean.warnings));
    // …but the DEFAULT components.buttonTextColor is 'light', i.e. white on
    // the brand amber = 2.03:1, which really does fail AA today (that is the
    // whole reason the presets ship buttonTextColor:'dark'). The check is
    // honest about it — a warning, never an error, and never on body text.
    const defaultLow = clean.warnings.filter((w) => w.code === 'low_contrast');
    assert.deepStrictEqual(defaultLow.map((w) => w.path), ['site.design.colors.primary'], JSON.stringify(defaultLow));

    // Hand-edited / imported design the store happily stored verbatim.
    const raw = rawSiteDoc(draft.siteId);
    raw.design.colors.textPrimary = '#CFCFCF';   // 1.7:1 on the cream background
    raw.design.colors.secondary = 'rebeccapurple';
    raw.design.fonts.body = 'Comic Papyrus';
    raw.design.colors.primary = '#F5A623';
    raw.design.components.buttonTextColor = 'light'; // white on amber = 2.03:1
    await refreshDraftSite(draft);

    const v = validateSiteDraft(draft);
    assert.strictEqual(v.errors.length, 0, 'design problems NEVER become errors');
    const codes = v.warnings.map((w) => w.code);
    assert.ok(codes.includes('bad_color'), JSON.stringify(v.warnings));
    assert.ok(codes.includes('unknown_font'), JSON.stringify(v.warnings));
    const lowContrast = v.warnings.filter((w) => w.code === 'low_contrast');
    assert.strictEqual(lowContrast.length, 2, JSON.stringify(lowContrast));
    assert.ok(lowContrast.some((w) => w.path === 'site.design.colors.textPrimary'));
    assert.ok(lowContrast.some((w) => w.path === 'site.design.colors.primary' && /2\.0\d:1/.test(w.message)), JSON.stringify(lowContrast));
    assert.ok(v.warnings.find((w) => w.code === 'unknown_font').hint.includes('Inter'), 'font hint lists the library');

    // buttonTextColor:'dark' fixes the amber CTA (10.1:1) — the check follows
    // the resolved label colour, not a hardcoded white.
    raw.design.components.buttonTextColor = 'dark';
    await refreshDraftSite(draft);
    assert.strictEqual(
        validateSiteDraft(draft).warnings.filter((w) => w.code === 'low_contrast' && w.path === 'site.design.colors.primary').length,
        0,
        'dark label on amber passes AA',
    );

    // Empty darkColors.primary/accent mean "reuse the light value" — not a bad colour.
    raw.design.darkColors.primary = '';
    raw.design.darkColors.accent = '';
    await refreshDraftSite(draft);
    assert.ok(
        !validateSiteDraft(draft).warnings.some((w) => w.code === 'bad_color' && w.path.startsWith('site.design.darkColors')),
        'blank dark primary/accent never warn',
    );
});

// ── Read tools ──────────────────────────────────────────────────────

test('cms_list_site + cms_get_page: outlines, full doc, unknown-id hints', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'hero' }, { type: 'cta' }] });

    const listed = await applyToolCall(draft, 'cms_list_site', {});
    assert.strictEqual(listed.site.name, 'Test site');
    assert.strictEqual(listed.site.defaultLocale, 'en');
    assert.ok(listed.site.designSummary.includes('primary'));
    assert.strictEqual(listed.pages.length, 1);
    assert.strictEqual(listed.pages[0].blockCount, 2);
    assert.deepStrictEqual(listed.pages[0].blockTypes, ['hero', 'cta']);

    const got = await applyToolCall(draft, 'cms_get_page', { pageId: home });
    assert.strictEqual(got.page.blocks.length, 2);
    assert.strictEqual(got.meta.id, home);

    const missing = await applyToolCall(draft, 'cms_get_page', { pageId: 'pg_ghost' });
    assert.ok(missing.error && missing._fixHint.includes(home), JSON.stringify(missing));

    const unknownTool = await applyToolCall(draft, 'cms_publish_site', {});
    assert.ok(unknownTool.error && unknownTool._fixHint.includes('cms_list_site'), 'unknown tool rejected with the roster');
});

// ── validateSiteDraft ───────────────────────────────────────────────

test('validateSiteDraft: dangling_page_link error (hint lists ids), empty_page + unknown_icon warnings', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [
            { type: 'cta', content: { button: { label: 'Go', link: { kind: 'page', pageId: 'pg_ghost' } } } },
            { type: 'features', content: { items: [{ icon: 'not-an-icon', title: 'X', body: 'y', techTag: '' }] } },
        ],
    });
    await applyToolCall(draft, 'cms_create_page', { title: 'Empty page' });

    const v = validateSiteDraft(draft);
    assert.strictEqual(v.ok, false);
    const dangling = v.errors.find((e) => e.code === 'dangling_page_link');
    assert.ok(dangling, JSON.stringify(v.errors));
    assert.ok(dangling.hint.includes(home), 'hint lists the known page ids');
    assert.ok(dangling.path.includes(home), dangling.path);
    assert.ok(v.warnings.some((w) => w.code === 'empty_page'), JSON.stringify(v.warnings));
    assert.ok(v.warnings.some((w) => w.code === 'unknown_icon' && w.message.includes('not-an-icon')), JSON.stringify(v.warnings));
});

test('validateSiteDraft: duplicate + reserved slugs surface as errors (legacy/import data)', async () => {
    const draft = await makeDraft();
    await applyToolCall(draft, 'cms_create_page', { title: 'Team' });
    // Corrupt the index directly (imports/legacy data can carry collisions
    // the store would never mint itself).
    draft.site.pages[1].slug = 'home';
    draft.site.pages.push({ id: 'pg_legacy1', slug: 'privacy', title: 'Old', isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false });
    const v = validateSiteDraft(draft);
    assert.ok(v.errors.some((e) => e.code === 'duplicate_slug'), JSON.stringify(v.errors));
    assert.ok(v.errors.some((e) => e.code === 'reserved_slug' && e.message.includes('privacy')), JSON.stringify(v.errors));
});

test('validateSiteDraft: header/footer icons exempt from unknown_icon; page blocks still checked; header links still checked', async () => {
    const draft = await makeDraft();
    const home = homeId(draft);
    // Emoji icon in the header mega menu — by design, must NOT warn.
    const navSet = await applyToolCall(draft, 'cms_update_header_nav', {
        nav: [{
            label: 'Product', link: { kind: 'page', pageId: home },
            dropdown: { layout: 'columns', columns: [{ heading: 'H', items: [{ label: 'App', link: { kind: 'app', path: '/app' }, icon: '🚀' }] }] },
        }],
    });
    assert.ok(!navSet.error, JSON.stringify(navSet));
    // Bad Lucide name in a page block — must STILL warn.
    await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [{ type: 'features', content: { items: [{ icon: 'not-an-icon', title: 'X', body: 'y', techTag: '' }] } }],
    });
    // Legacy corruption: a dangling page link in the header must STILL error
    // (the icon exemption is surgical — link checks keep covering chrome).
    draft.site.header.nav.push({ id: 'nav_legacy', label: 'Old', link: { kind: 'page', pageId: 'pg_gone' } });

    const v = validateSiteDraft(draft);
    const iconWarnings = v.warnings.filter((w) => w.code === 'unknown_icon');
    assert.strictEqual(iconWarnings.length, 1, JSON.stringify(iconWarnings));
    assert.ok(iconWarnings[0].path.startsWith(`pages.${home}`), iconWarnings[0].path);
    assert.ok(!iconWarnings.some((w) => w.path.startsWith('site.header')), 'emoji header icons never warn');
    const dangling = v.errors.filter((e) => e.code === 'dangling_page_link');
    assert.ok(dangling.some((e) => e.path.startsWith('site.header')), JSON.stringify(dangling));
});

// ── cmsStore builder-session snapshot (trim discipline) ─────────────

test('cmsStore builder session: round-trip + ≤64KB trim drops OLDEST messages first', async () => {
    const draft = await makeDraft();
    assert.strictEqual(await cmsStore.getBuilderSession(draft.siteId), null);

    const big = 'x'.repeat(8 * 1024);
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${big}` }));
    await cmsStore.setBuilderSession(draft.siteId, {
        sessionId: 'cms_trim', siteId: draft.siteId, messages, updatedAt: 'now', lastTier: 'fast',
    });
    const stored = await cmsStore.getBuilderSession(draft.siteId);
    assert.ok(stored.messages.length < 20, `trimmed (${stored.messages.length})`);
    assert.ok(JSON.stringify(stored).length <= 64 * 1024 + 1024, 'fits the 64KB budget');
    assert.ok(stored.messages[stored.messages.length - 1].content.startsWith('19:'), 'newest kept');
    assert.ok(!stored.messages.some((m) => m.content.startsWith('0:')), 'oldest dropped first');
    assert.strictEqual(stored.sessionId, 'cms_trim');
});

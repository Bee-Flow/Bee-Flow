// @typecheck
/**
 * CMS design controls (#221): block background placement, the built-in brand
 * motif, per-language media and the heavier display type. The REAL cmsStore
 * runs against the in-memory config harness (see cmsBuilder/builderTools.test.js).
 *
 * Run: node --test cmsBuilder/cmsDesignControls.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const { applyToolCall } = require('./builderTools');
const { validateSiteDraft } = require('./validate');
const { validateStylePatch } = require('./blockStyle');
const { sanitizeBlockDesignStyle, cleanBackgroundSize } = require('../i18n/defaults/blockStyleEnums');
const { safeMediaRef, cleanOverrideMedia, applyOverrideMedia } = require('../stores/cms/localeMedia');

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Test site' });
    const site = await cmsStore.getProject(created.id);
    const pages = new Map();
    for (const entry of site.pages) pages.set(entry.id, await cmsStore.getPage(created.id, entry.id));
    return {
        siteId: created.id, userId: 'u1', orgId: 'orgA', builderSessionId: 'cms_test',
        site, pages, defaultLocale: 'en', locales: [], createdPageIds: [], touchedPageIds: new Set(),
    };
}

// ── Background placement + motif: enum whitelist, no free CSS ───────

test('cleanBackgroundSize: enum members and a bounded pixel width, nothing else', () => {
    for (const ok of ['cover', 'contain', 'auto', ' COVER ', '480px', 480, '16px', '2400px']) {
        assert.ok(cleanBackgroundSize(ok), String(ok));
    }
    assert.strictEqual(cleanBackgroundSize(480), '480px');
    for (const bad of ['15px', '2401px', '50%', '10rem', 'url(x.png)', 'cover, url(//evil)', '480px 20px', '1e3px', '-5px', null, {}, '']) {
        assert.strictEqual(cleanBackgroundSize(bad), null, JSON.stringify(bad));
    }
});

test('validateStylePatch: placement and motif keys accept their enum, reject free CSS with a fix hint', () => {
    const ok = validateStylePatch({
        backgroundImage: 'cms/x.svg', backgroundSize: '480px', backgroundPosition: 'top-right', backgroundRepeat: 'repeat-x',
        backgroundHideMobile: true, motif: 'honeycomb', motifSide: 'left', motifTiles: true,
    });
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.deepStrictEqual(ok.style, {
        backgroundImage: 'cms/x.svg', backgroundSize: '480px', backgroundPosition: 'top-right', backgroundRepeat: 'repeat-x',
        backgroundHideMobile: true, motif: 'honeycomb', motifSide: 'left', motifTiles: true,
    });
    for (const patch of [
        { backgroundSize: 'url(//evil.example/x.png)' },
        { backgroundSize: '50%' },
        { backgroundPosition: '10px 20px' },
        { backgroundPosition: 'center; background: url(x)' },
        { backgroundRepeat: 'space' },
        { backgroundHideMobile: 'yes' },
        { motif: 'url(x)' },
        { motifSide: 'top' },
        { motifTiles: 1 },
    ]) {
        const r = validateStylePatch(patch);
        assert.ok(r.error && r._fixHint, JSON.stringify(patch));
    }
});

test('sanitizeBlockDesignStyle: drops every illegal design value, leaves other keys alone', () => {
    const out = sanitizeBlockDesignStyle({
        band: 'dark', backgroundSize: 'url(x)', backgroundPosition: 'left', backgroundRepeat: 'nope',
        backgroundHideMobile: 'true', motif: 'honeycomb', motifSide: '<script>', motifTiles: false,
    });
    assert.deepStrictEqual(out, { band: 'dark', backgroundPosition: 'left', motif: 'honeycomb', motifTiles: false });
});

test('cms_update_block: stylePatch with the new keys is stored; a bad value changes nothing', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const added = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'hero' }] });
    const blockId = added.blockIds[0];
    const ok = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId, stylePatch: { motif: 'honeycomb', motifSide: 'right', backgroundSize: '320px' } });
    assert.ok(!ok.error, JSON.stringify(ok));
    const style = draft.pages.get(home).blocks[0].style;
    assert.strictEqual(style.motif, 'honeycomb');
    assert.strictEqual(style.backgroundSize, '320px');
    const bad = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId, stylePatch: { backgroundSize: 'url(x)' } });
    assert.ok(bad.error);
    assert.strictEqual(draft.pages.get(home).blocks[0].style.backgroundSize, '320px');
});

test('store sanitizer: a page saved with illegal design style values loses them', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const page = await cmsStore.getPage(draft.siteId, home);
    page.blocks = [{ id: 'blk_a', type: 'hero', enabled: true, content: {}, style: { motif: 'honeycomb', backgroundSize: 'url(//evil)', backgroundPosition: 'center' } }];
    await cmsStore.setPage(draft.siteId, page);
    const stored = await cmsStore.getPage(draft.siteId, home);
    assert.deepStrictEqual(stored.blocks[0].style, { motif: 'honeycomb', backgroundPosition: 'center' });
});

test('validateSiteDraft: warns on an illegal design style value and on a bad bento media setting', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    draft.pages.get(home).blocks = [
        { id: 'blk_a', type: 'hero', enabled: true, content: {}, style: { backgroundSize: '50%', motif: 'honeycomb' } },
        { id: 'blk_b', type: 'features', enabled: true, content: { variant: 'bento', items: [{ title: 'x', mediaHeight: 'huge', mediaFit: 'contain' }] }, style: {} },
    ];
    const { warnings } = validateSiteDraft(draft);
    const paths = warnings.filter((w) => /unknown_(style|item)_value/.test(w.code)).map((w) => w.path);
    assert.ok(paths.some((p) => p.endsWith('blocks[0].style.backgroundSize')), paths.join('\n'));
    assert.ok(!paths.some((p) => p.endsWith('style.motif')));
    assert.ok(paths.some((p) => p.endsWith('items[0].mediaHeight')));
    assert.ok(!paths.some((p) => p.endsWith('items[0].mediaFit')));
});

// ── Heavier display type ────────────────────────────────────────────

test('sanitizeDesign: heading weight 800/900 and the display tracking enum', () => {
    const { sanitizeDesign } = require('../stores/cms/shared');
    const heavy = sanitizeDesign({ typography: { headingWeight: 900, displayTracking: 'tightest' } });
    assert.strictEqual(heavy.typography.headingWeight, 900);
    assert.strictEqual(heavy.typography.displayTracking, 'tightest');
    const bad = sanitizeDesign({ typography: { headingWeight: 950, displayTracking: '-3px; color:red' } });
    assert.strictEqual(bad.typography.headingWeight, 600, 'falls back to the default weight');
    assert.strictEqual(bad.typography.displayTracking, 'default');
    assert.strictEqual(sanitizeDesign({}).typography.displayTracking, 'default');
});

// ── Hero decor, card fill, trust label style, dark band fill ────────

test('block style: decor, cardFill and labelStyle accept their enum and drop anything else', () => {
    const ok = validateStylePatch({ decor: 'none', cardFill: 'white', labelStyle: 'plain' });
    assert.deepStrictEqual(ok.style, { decor: 'none', cardFill: 'white', labelStyle: 'plain' });
    for (const patch of [{ decor: 'blur(9px)' }, { cardFill: '#fff' }, { labelStyle: 'uppercase; x' }]) {
        const res = validateStylePatch(patch);
        assert.ok(res.error && res._fixHint, JSON.stringify(patch));
    }
    assert.deepStrictEqual(
        sanitizeBlockDesignStyle({ decor: 'none', cardFill: 'url(x)', labelStyle: 3, band: 'dark' }),
        { decor: 'none', band: 'dark' },
    );
});

test('block style: the tile keys take the theme tile enums and drop anything else', () => {
    const { DESIGN_COMPONENT_ENUMS } = require('../i18n/defaults/cmsDefaults');
    const { TILE_SHAPES, TILE_FILLS, TILE_SIZES, TILE_ICON_COLORS } = require('../i18n/defaults/blockStyleEnums');
    assert.deepStrictEqual(TILE_SHAPES, DESIGN_COMPONENT_ENUMS.tileShape);
    assert.deepStrictEqual(TILE_FILLS, DESIGN_COMPONENT_ENUMS.tileFill);
    assert.deepStrictEqual(TILE_SIZES, DESIGN_COMPONENT_ENUMS.tileSize);
    assert.deepStrictEqual(TILE_ICON_COLORS, DESIGN_COMPONENT_ENUMS.tileIconColor);
    const ok = validateStylePatch({ tileShape: 'hexagon', tileFill: 'solid', tileSize: 'lg', tileIconColor: 'dark' });
    assert.deepStrictEqual(ok.style, { tileShape: 'hexagon', tileFill: 'solid', tileSize: 'lg', tileIconColor: 'dark' });
    for (const patch of [{ tileShape: 'polygon(0 0)' }, { tileFill: 'red' }, { tileSize: '99px' }, { tileIconColor: 'x;y' }]) {
        const res = validateStylePatch(patch);
        assert.ok(res.error && res._fixHint, JSON.stringify(patch));
    }
    assert.deepStrictEqual(
        sanitizeBlockDesignStyle({ tileShape: 'circle', tileFill: 'url(x)', band: 'dark' }),
        { tileShape: 'circle', band: 'dark' },
    );
});

test('sanitizeDesign + cms_update_design: darkBand is palette | secondary', async () => {
    const { sanitizeDesign } = require('../stores/cms/shared');
    assert.strictEqual(sanitizeDesign({}).darkBand, 'palette');
    assert.strictEqual(sanitizeDesign({ darkBand: 'secondary' }).darkBand, 'secondary');
    assert.strictEqual(sanitizeDesign({ darkBand: '#000' }).darkBand, 'palette');
    const draft = await makeDraft();
    const ok = await applyToolCall(draft, 'cms_update_design', { darkBand: 'secondary' });
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.strictEqual(draft.site.design.darkBand, 'secondary');
    const bad = await applyToolCall(draft, 'cms_update_design', { darkBand: 'red' });
    assert.ok(bad.error);
});

// ── Per-language media ──────────────────────────────────────────────

test('safeMediaRef: asset keys, site paths and http(s) pass; script/data URLs and markup do not', () => {
    for (const ok of ['cms/clip-nl.mp4', '/api/cms/asset/cms/poster.jpg', 'https://cdn.example.com/a/b.webm?v=2', ' cms/x.png ']) {
        assert.ok(safeMediaRef(ok), ok);
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AAAA', '//evil.example/x.png', 'cms/../secret', 'cms/a b.png',
        'https://x.example/"onerror=1', '/a/../b', 'ftp://x.example/a', '', '   ', 5, null, 'cms/<img>']) {
        assert.strictEqual(safeMediaRef(bad), '', JSON.stringify(bad));
    }
});

test('cleanOverrideMedia / applyOverrideMedia: media keys are validated, text untouched, poster added to a slot', () => {
    const override = { media: { src: 'cms/nl.mp4', poster: 'javascript:x', alt: 'Beschrijving' }, items: [null, { media: { src: '/api/cms/asset/cms/n.png' } }] };
    const clean = cleanOverrideMedia(override);
    assert.deepStrictEqual(clean, { media: { src: 'cms/nl.mp4', alt: 'Beschrijving' }, items: [null, { media: { src: '/api/cms/asset/cms/n.png' } }] });
    const base = { media: { src: 'cms/en.mp4', alt: 'Description', kind: 'clip' }, items: [{ media: { src: 'cms/a.png' } }, { media: { src: 'cms/b.png' } }] };
    const merged = applyOverrideMedia(base, { media: { poster: 'cms/p-nl.jpg', src: 'cms/nl.mp4' }, items: [null, { media: { src: '/api/cms/asset/cms/n.png' } }] });
    assert.deepStrictEqual(merged, {
        media: { src: 'cms/nl.mp4', alt: 'Description', kind: 'clip', poster: 'cms/p-nl.jpg' },
        items: [{ media: { src: 'cms/a.png' } }, { media: { src: '/api/cms/asset/cms/n.png' } }],
    });
    // A media key never creates structure the default does not have.
    assert.deepStrictEqual(applyOverrideMedia({ title: 'x' }, { poster: 'cms/p.jpg', other: { src: 'cms/z.png' } }), { title: 'x' });
});

test('locale override media: stored cleaned, served in the requested language only, never from a hostile value', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const page = await cmsStore.getPage(draft.siteId, home);
    page.blocks = [{ id: 'blk_m', type: 'media-text', enabled: true, content: { title: 'Intro', media: { src: 'cms/en.mp4', kind: 'clip', alt: 'Clip' } }, style: {} }];
    await cmsStore.setPage(draft.siteId, page);
    await cmsStore.setPageLocaleOverride(draft.siteId, home, 'nl', {
        blocks: { blk_m: { content: { title: 'Intro NL', media: { src: 'cms/nl.mp4', poster: 'cms/nl.jpg', srcDark: 'data:image/svg+xml,<svg/>' } } } },
    });
    const stored = await cmsStore.getPageLocaleOverride(draft.siteId, home, 'nl');
    assert.deepStrictEqual(stored.blocks.blk_m.content.media, { src: 'cms/nl.mp4', poster: 'cms/nl.jpg' }, 'the data: address never reaches storage');
    const nl = await cmsStore.getEffective(draft.siteId, '', 'nl');
    const nlMedia = nl.page.blocks[0].content.media;
    assert.strictEqual(nlMedia.src, 'cms/nl.mp4');
    assert.strictEqual(nlMedia.poster, 'cms/nl.jpg');
    assert.strictEqual(nl.page.blocks[0].content.title, 'Intro NL');
    const en = await cmsStore.getEffective(draft.siteId, '', 'en');
    assert.strictEqual(en.page.blocks[0].content.media.src, 'cms/en.mp4');
    assert.strictEqual(en.page.blocks[0].content.media.poster, undefined);
});

test('locale override media: a hostile address written around the setter is still dropped at read time', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const page = await cmsStore.getPage(draft.siteId, home);
    page.blocks = [{ id: 'blk_m', type: 'media-text', enabled: true, content: { media: { src: 'cms/en.png' } }, style: {} }];
    await cmsStore.setPage(draft.siteId, page);
    const { resolveEffective } = require('../stores/cms/effective');
    const site = await cmsStore.getProject(draft.siteId);
    const eff = await resolveEffective(draft.siteId, '', 'nl', {
        getSite: async () => site,
        getPage: async () => page,
        getSiteLocaleOverride: async () => null,
        getPageLocaleOverride: async () => ({ blocks: { blk_m: { content: { media: { src: 'javascript:alert(1)' } } } } }),
    });
    assert.strictEqual(eff.page.blocks[0].content.media.src, 'cms/en.png');
});

// ── Icon tiles and colour roles (#254, #255) ────────────────────────

const { sanitizeDesign } = require('../stores/cms/shared');
const { safeIconAsset } = require('../stores/cms/localeMedia');

test('safeIconAsset: only uploaded-asset addresses, never another origin or markup', () => {
    for (const ok of ['cms/icon.svg', ' /api/cms/asset/cms/icon.png ']) assert.ok(safeIconAsset(ok), ok);
    for (const bad of ['https://x.example/i.svg', '/other/path.svg', '//evil.example/i.svg', 'cms/../x', 'cms/a b.svg',
        'javascript:alert(1)', 'Shield', '', null, 4]) {
        assert.strictEqual(safeIconAsset(bad), '', JSON.stringify(bad));
    }
});

test('sanitizeDesign: colour roles default to blank (follow primary), accept only #rrggbb', () => {
    const base = sanitizeDesign({});
    for (const role of ['cta', 'link', 'highlight', 'tile']) assert.strictEqual(base.colors[role], '', role);
    const set = sanitizeDesign({ colors: { cta: '#1F2937', link: '#0b5fff', highlight: 'red', tile: 'url(x)' } });
    assert.strictEqual(set.colors.cta, '#1F2937');
    assert.strictEqual(set.colors.link, '#0b5fff');
    assert.strictEqual(set.colors.highlight, '', 'a colour name is dropped to "follow primary"');
    assert.strictEqual(set.colors.tile, '', 'free CSS is dropped');
});

test('sanitizeDesign: labelStyle is an enum with an identity default', () => {
    assert.strictEqual(sanitizeDesign({}).components.labelStyle, 'mono');
    assert.strictEqual(sanitizeDesign({ components: { labelStyle: 'plain' } }).components.labelStyle, 'plain');
    assert.strictEqual(sanitizeDesign({ components: { labelStyle: 'uppercase; color:red' } }).components.labelStyle, 'mono');
});

test('cms_update_design: role colours (blank allowed) and the label style are validated', async () => {
    const draft = await makeDraft();
    const ok = await applyToolCall(draft, 'cms_update_design', {
        colorsPatch: { cta: '#F5A623', tile: '#1F2937', link: '' },
        componentsPatch: { labelStyle: 'plain' },
    });
    assert.ok(!ok.error, JSON.stringify(ok));
    const stored = (await cmsStore.getProject(draft.siteId)).design;
    assert.strictEqual(stored.colors.cta, '#F5A623');
    assert.strictEqual(stored.colors.tile, '#1F2937');
    assert.strictEqual(stored.colors.link, '');
    assert.strictEqual(stored.components.labelStyle, 'plain');
    assert.strictEqual(stored.colors.primary, '#F5A623', 'the primary is untouched by a role patch');
    for (const args of [
        { colorsPatch: { cta: 'navy' } },
        { colorsPatch: { highlight: 'rgb(0,0,0)' } },
        { colorsPatch: { primary: '' } },
        { componentsPatch: { labelStyle: 'url(x)' } },
    ]) {
        const r = await applyToolCall(draft, 'cms_update_design', args);
        assert.ok(r.error, JSON.stringify(args));
    }
});

test('sanitizeDesign: tile enums default to the identity value and drop anything else', () => {
    const base = sanitizeDesign({});
    assert.deepStrictEqual(
        [base.components.tileShape, base.components.tileFill, base.components.tileSize, base.components.tileIconColor],
        ['default', 'default', 'default', 'default'],
    );
    const set = sanitizeDesign({ components: { tileShape: 'hexagon', tileFill: 'solid', tileSize: 'lg', tileIconColor: 'light' } });
    assert.strictEqual(set.components.tileShape, 'hexagon');
    assert.strictEqual(set.components.tileFill, 'solid');
    assert.strictEqual(set.components.tileSize, 'lg');
    const bad = sanitizeDesign({ components: { tileShape: 'polygon(0 0)', tileSize: '99px' } });
    assert.strictEqual(bad.components.tileShape, 'default');
    assert.strictEqual(bad.components.tileSize, 'default');
});

test('cms_update_design: tile enums are validated', async () => {
    const draft = await makeDraft();
    const ok = await applyToolCall(draft, 'cms_update_design', {
        componentsPatch: { tileShape: 'hexagon', tileFill: 'solid', tileIconColor: 'light' },
    });
    assert.ok(!ok.error, JSON.stringify(ok));
    const stored = (await cmsStore.getProject(draft.siteId)).design;
    assert.strictEqual(stored.components.tileShape, 'hexagon');
    assert.strictEqual(stored.components.tileFill, 'solid');
    assert.strictEqual(stored.colors.primary, '#F5A623', 'colours are untouched by a tile patch');
    for (const args of [
        { componentsPatch: { tileShape: 'star' } },
        { componentsPatch: { tileSize: '99px' } },
        { componentsPatch: { tileFill: 'url(x)' } },
    ]) {
        const r = await applyToolCall(draft, 'cms_update_design', args);
        assert.ok(r.error, JSON.stringify(args));
    }
});

test('cms_update_header_nav: a mega item icon may be a Lucide name, an uploaded asset or legacy emoji; foreign addresses are rejected', async () => {
    const draft = await makeDraft();
    const item = (icon) => ({ label: 'Docs', link: { kind: 'app', path: '/app' }, icon });
    const nav = (icon) => ({ nav: [{ label: 'Menu', link: { kind: 'app', path: '/app' }, dropdown: { columns: [{ heading: 'H', items: [item(icon)] }] } }] });
    for (const icon of ['ShieldCheck', '/api/cms/asset/cms/shield.svg', 'cms/shield.svg', '🚀']) {
        const r = await applyToolCall(draft, 'cms_update_header_nav', nav(icon));
        assert.ok(!r.error, `${icon}: ${JSON.stringify(r)}`);
        assert.strictEqual(draft.site.header.nav[0].dropdown.columns[0].items[0].icon, icon);
    }
    for (const icon of ['//evil.example/i.svg', '/other/i.svg', 'cms/../x.svg', 'cms/a b.svg']) {
        const r = await applyToolCall(draft, 'cms_update_header_nav', nav(icon));
        assert.ok(r.error, icon);
        assert.match(r._fixHint, /Lucide|asset/i);
    }
});

test('validateSiteDraft: an uploaded-asset icon is fine in blocks and chrome, a foreign address warns', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const page = await cmsStore.getPage(draft.siteId, home);
    page.blocks = [{ id: 'blk_i', type: 'features', enabled: true, style: {}, content: { items: [
        { icon: '/api/cms/asset/cms/a.svg', title: 'A', body: 'a', techTag: '' },
        { icon: '//evil.example/a.svg', title: 'B', body: 'b', techTag: '' },
    ] } }];
    await cmsStore.setPage(draft.siteId, page);
    draft.pages.set(home, page);
    draft.site = await cmsStore.getProject(draft.siteId);
    const v = validateSiteDraft(draft);
    const codes = v.warnings.filter((w) => /icon/.test(w.code));
    assert.strictEqual(codes.length, 1, JSON.stringify(codes));
    assert.ok(codes[0].path.endsWith('items[1].icon'), codes[0].path);
});

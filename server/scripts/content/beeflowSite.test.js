/**
 * The seeded Bee Flow website must actually survive the CMS.
 *
 * Hand-authored content fails in quiet ways: a block type the store does not
 * know is DROPPED on save with no error, a design value outside its enum is
 * silently coerced to the default, an internal link with a slug nobody
 * created renders as `#`, and an asset key that was never uploaded shows an
 * empty skeleton. None of that surfaces until someone opens the published
 * page — by which point the seed has already run.
 *
 * So this runs the real store against the real bundle, on an in-memory
 * config table, and asserts the site comes out the other side intact.
 *
 * Run: node --test scripts/content/beeflowSite.test.js
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

const cmsStore = require('../../stores/cmsStore');
const { BLOCK_TYPE_IDS, RESERVED_SLUGS, DESIGN_FONTS, DEMO_FEATURE_IDS } = require('../../i18n/defaults/cmsDefaults');
const { THEME_PRESET_IDS } = require('../../i18n/defaults/themePresets');
const { sanitizeSvg } = require('../../utils/svgSanitizer');
const { buildBundle, PAGES } = require('./beeflowSite');
const { ASSETS, KEYS } = require('./beeflowAssets');

const bundle = buildBundle({ exportedAt: '2026-07-28T00:00:00.000Z' });

// ── Static shape ─────────────────────────────────────────────────────

test('every block type in the seed exists in the catalogue', () => {
    const unknown = [];
    for (const page of PAGES) {
        for (const block of page.blocks) {
            if (!BLOCK_TYPE_IDS.includes(block.type)) unknown.push(`${page.slug}: ${block.type}`);
        }
    }
    assert.deepStrictEqual(unknown, [], 'an unknown type is dropped by setPage without an error');
});

test('no page uses a slug the app has already claimed', () => {
    const reserved = RESERVED_SLUGS instanceof Set ? RESERVED_SLUGS : new Set(RESERVED_SLUGS);
    const clashes = PAGES.map(p => p.slug).filter(s => reserved.has(s));
    assert.deepStrictEqual(clashes, [], '/pricing, /privacy, /terms and /legal are app routes — pricing lives at /plans');
});

test('slugs are publicly routable and unique, with exactly one homepage', () => {
    const slugs = PAGES.map(p => p.slug);
    assert.strictEqual(new Set(slugs).size, slugs.length, 'duplicate slugs get suffixed on import');
    for (const s of slugs) {
        assert.match(s, /^[a-z0-9][a-z0-9-]*$/, `"${s}" is storable but the public router will not reach it`);
    }
    assert.strictEqual(PAGES.filter(p => p.isHomepage).length, 1);
});

test('the design doc is valid — a bad value would be silently swapped for a default', () => {
    // sanitizeDesign never rejects — it coerces — so the only way to catch a
    // typo here is to check the values against the same enums it uses. The
    // round-trip test below then proves nothing was coerced on the way in.
    const d = bundle.site.design;
    assert.ok(THEME_PRESET_IDS.includes(d.preset), 'preset must be one of the shipped themes');
    for (const [role, family] of Object.entries(d.fonts)) {
        assert.ok(DESIGN_FONTS.includes(family), `${role} font "${family}" is not in the allowlist — it would 404 and fall back`);
    }
    for (const [key, value] of Object.entries(d.colors)) {
        assert.match(value, /^#[0-9A-Fa-f]{6}$/, `colors.${key} must be a full 6-digit hex`);
    }
    assert.strictEqual(d.components.buttonTextColor, 'dark',
        'white on #F5A623 is 2.03:1 and fails AA — the amber theme needs dark button labels');
});

// The demo components live in the frontend (React lazy() imports, so the id
// list is mirrored server-side in cmsDefaults). The client half of that
// contract is asserted in agent-hub/src/demo/DemoHost.test.jsx. A live-demo
// block naming anything else renders a placeholder on a marketing page —
// visible, but only if someone looks.
const REGISTERED_DEMOS = DEMO_FEATURE_IDS;

test('every live-demo block points at a registered demo', () => {
    const used = [];
    for (const page of PAGES) {
        for (const block of page.blocks) {
            if (block.type === 'feature-demo') used.push([page.slug, block.content.feature]);
        }
    }
    assert.ok(used.length >= 2, 'the feature pages should each carry a live demo');
    for (const [slug, feature] of used) {
        assert.ok(REGISTERED_DEMOS.includes(feature),
            `/${slug} embeds demo "${feature}", which is not in the frontend registry`);
    }
});

// Nine blocks shipped to the published site showing "add an image here",
// because `media-text` renders its media column unconditionally and every
// block was authored with frame:'hairline' and src:''. The renderer now lays
// out text-only when the slot is empty (MediaText.test.jsx pins that), and
// this pins the content side: no block may declare a FRAME it has no image
// for, because that pairing is what asks for a placeholder.
test('no block asks for a frame it has no image for', () => {
    const offenders = [];
    const walk = (node, where) => {
        if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
        if (!node || typeof node !== 'object') return;
        const isMediaSlot = Object.prototype.hasOwnProperty.call(node, 'src')
            && Object.prototype.hasOwnProperty.call(node, 'frame');
        if (isMediaSlot) {
            const framed = node.frame === 'hairline' || node.frame === 'browser';
            const empty = !String(node.src || '').trim();
            if (framed && empty) offenders.push(where);
            return;
        }
        for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
    };
    for (const page of PAGES) walk(page.blocks, page.slug);

    assert.deepStrictEqual(offenders, [],
        'a framed-but-empty media slot renders a placeholder box on the public site');
});

// The live Dutch pricing page advertises €30,00 and €150,00, baked into a
// pasted HTML block — matching neither Stripe nor the seeder, and invisible to
// anyone editing the page. Prices belong in ONE place: the plans table, read
// by the `pricing` block. So no currency figure may appear in authored copy.
test('no page hardcodes a price', () => {
    const offenders = [];
    // A bare € or $ next to digits. Deliberately narrow: "€5 of AI spend" is
    // as wrong to hardcode as "€30/month", because both go stale the moment
    // somebody edits a plan.
    const MONEY = /[€$£]\s?\d|(?:\d+[.,]\d{2}\s?(?:EUR|USD|GBP))|\b\d+\s?(?:euro|euros)\b/i;
    for (const page of PAGES) {
        for (const block of page.blocks) {
            const text = JSON.stringify(block.content);
            const hit = text.match(MONEY);
            if (hit) offenders.push(`${page.slug} / ${block.type}: ${hit[0]}`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'prices must come from the plans table via the `pricing` block, never from copy');
});

test('the pricing page renders plans from the billing config', () => {
    const page = PAGES.find(p => p.slug === 'pricing');
    assert.ok(page, 'the product hardcodes <host>/pricing as its upgrade URL — the page must exist at that slug');

    const block = page.blocks.find(b => b.type === 'pricing');
    assert.ok(block, 'the pricing page must carry a `pricing` block, or it shows no plans at all');

    // The block's defaults are Dutch literals (cmsDefaults BLOCK_DEFAULTS.pricing).
    // An English page that forgets to override them renders half-Dutch.
    const DUTCH = ['Maandelijks', 'Jaarlijks', 'Kies plan', 'Geen plannen beschikbaar',
        '/maand', '/jaar', 'Op aanvraag', 'dagen gratis proberen'];
    const copy = JSON.stringify(block.content);
    const leaked = DUTCH.filter(d => copy.includes(d));
    assert.deepStrictEqual(leaked, [], 'these Dutch defaults were not overridden');
});

test('every page is substantial enough to be worth visiting', () => {
    const thin = [];
    for (const page of PAGES) {
        const words = (JSON.stringify(page.blocks).match(/[A-Za-z']{3,}/g) || []).length;
        if (page.blocks.length < 5 || words < 550) {
            thin.push(`${page.slug}: ${page.blocks.length} blocks, ${words} words`);
        }
    }
    assert.deepStrictEqual(thin, [], 'these pages are too thin to publish');
});

test('no two pages have the same block sequence', () => {
    // Three feature pages once came out of one factory and were literally the
    // same page three times. A shared spine is fine; an identical skeleton is
    // not, and it is invisible unless you diff them.
    const seen = new Map();
    const clashes = [];
    for (const page of PAGES) {
        const shape = page.blocks.map(blk => blk.type).join('>');
        if (seen.has(shape)) clashes.push(`${seen.get(shape)} and ${page.slug} are identical: ${shape}`);
        else seen.set(shape, page.slug);
    }
    assert.deepStrictEqual(clashes, []);
});

test('every referenced asset key is one we actually ship', () => {
    const referenced = cmsStore.collectAssetKeys(bundle);
    const { resolveOgImages } = require('./beeflowAssets');
    const available = new Set([
        ...Object.keys(ASSETS),
        ...resolveOgImages().map(img => img.key),
    ]);
    for (const key of referenced) {
        assert.ok(available.has(key), `${key} is referenced but never uploaded — it would render as an empty skeleton`);
    }
    // …and the artwork is actually used, so a stale asset does not linger.
    assert.ok(referenced.has(KEYS.logo));
    assert.ok(referenced.has(KEYS.architecture));
});

// Social scrapers (LinkedIn, X, Slack, WhatsApp) render no SVG previews —
// every page shipped an SVG og:image and every shared link showed an empty
// card. The cards are committed PNGs; this pins both the reference and the
// bytes, including the 1200×630 shape the scrapers expect.
test('every og:image is a committed 1200×630 PNG', () => {
    const fs = require('node:fs');
    const { resolveOgImages } = require('./beeflowAssets');

    for (const page of PAGES) {
        assert.match(String(page.seo?.ogImage || ''), /\.png$/,
            `${page.slug}: og:image must be a PNG — scrapers do not render SVG`);
    }

    for (const img of resolveOgImages()) {
        assert.ok(fs.existsSync(img.file),
            `${img.file} is missing — run: node scripts/renderOgImages.js`);
        // `buf` is the committed PNG's own bytes, read to check its real
        // dimensions — not a source file the source-text counter should flag.
        const buf = fs.readFileSync(img.file);
        // PNG IHDR: width and height are big-endian uint32 at offsets 16/20.
        assert.strictEqual(buf.readUInt32BE(16), 1200, `${img.key} width`);
        assert.strictEqual(buf.readUInt32BE(20), 630, `${img.key} height`);
    }
});

test('every SVG survives the sanitizer the upload path uses', () => {
    for (const [key, svg] of Object.entries(ASSETS)) {
        const clean = sanitizeSvg(Buffer.from(svg, 'utf8'));
        assert.ok(clean, `${key} fails sanitizeSvg — it would be skipped on import`);
        assert.ok(!/<script/i.test(String(clean)), `${key} must not contain script`);
    }
});

// ── Round trip through the real store ────────────────────────────────

test('the bundle imports with nothing dropped and nothing warned', async () => {
    const result = await cmsStore.importSite(bundle);
    assert.strictEqual(result.dropped, 0, 'blocks were silently dropped — the page would render short');
    assert.deepStrictEqual(result.warnings, []);

    const site = await cmsStore.getProject(result.siteId);
    assert.strictEqual(site.pages.length, PAGES.length);
    assert.deepStrictEqual(site.pages.map(p => p.slug), PAGES.map(p => p.slug), 'page order is the sitemap order');
    assert.strictEqual(site.pages.find(p => p.isHomepage).slug, 'home');
});

test('every internal link resolves — no header, footer or CTA points at #', async () => {
    const { siteId } = await cmsStore.importSite(bundle);
    const broken = [];

    const walk = (node, where) => {
        if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
        if (!node || typeof node !== 'object') return;
        if (node.broken === true) broken.push(where);
        for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
    };

    for (const page of PAGES) {
        const eff = await cmsStore.getEffective(siteId, page.isHomepage ? '' : page.slug, 'en');
        assert.strictEqual(eff.found, true, `/${page.slug} did not resolve`);
        walk(eff.header, `${page.slug}:header`);
        walk(eff.footer, `${page.slug}:footer`);
        walk(eff.page.blocks, `${page.slug}:blocks`);
    }

    assert.deepStrictEqual(broken, [],
        'a {kind:"page"} link whose slug does not exist renders as "#" with no visible error');
});

test('the mega menus survive \u2014 stored verbatim and easy to get wrong', async () => {
    const { siteId } = await cmsStore.importSite(bundle);
    const site = await cmsStore.getProject(siteId);

    // Two mega menus now, not one. `Sovereignty` is deliberately top-level
    // rather than a link under `Security`: it is the differentiator, and the
    // nav order is part of the positioning.
    for (const label of ['Platform', 'Sovereignty', 'Compare', 'Resources']) {
        const entry = site.header.nav.find(n => n.label === label);
        assert.ok(entry?.dropdown, `the ${label} mega menu must persist`);
        assert.strictEqual(entry.dropdown.layout, 'columns',
            "'list' stores data that renders nothing");
        assert.ok(entry.dropdown.columns.length > 0);
        for (const col of entry.dropdown.columns) {
            assert.ok(col.items.length > 0);
            for (const item of col.items) {
                assert.ok(item.label && item.link, 'every mega item needs a label and a link');
            }
        }
    }

    // Five top-level items, and SIX is the ceiling. Seven stopped fitting: the
    // mobile breakpoint had already been moved to 1024px to cope, and adding
    // more would push the nav into the logo again. It came down to five when
    // /solutions was removed \u2014 the page restated what Platform and the demo
    // pages already showed, and a nav item pointing at a summary of the rest
    // of the nav is a rung nobody needs to climb.
    assert.ok(site.header.nav.length <= 6,
        `the top-level nav is capped at six \u2014 it does not fit otherwise (found ${site.header.nav.length})`);
    assert.strictEqual(site.header.nav.length, 5);

    // Icons are Lucide names, not emoji. NavIcon renders anything that is not
    // PascalCase verbatim (back-compat for older seeds), so an emoji here
    // would not throw \u2014 it would just render, in whatever the visitor's OS
    // emoji font happens to be.
    for (const entry of site.header.nav) {
        for (const col of entry.dropdown?.columns || []) {
            for (const item of col.items) {
                if (!item.icon) continue;
                assert.match(item.icon, /^[A-Z][A-Za-z0-9]*$/,
                    `${item.label}: nav icons are Lucide names, not emoji`);
            }
        }
    }
});

// \u2500\u2500 No emoji anywhere in the site payload \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Emoji render in the visitor's OS font: the same page is Apple's glossy set
// on a Mac, Segoe on Windows and Noto on Android \u2014 three visual languages,
// none of them ours, all at a weight nothing else on the page shares. Next to
// a line-drawn product UI it reads as generated filler, which is the opposite
// of what a privacy product is selling.
//
// Typographic marks are fine and deliberately not flagged: \u2014 dashes,
// \u2192 arrows, \u00b7 middots, quotes. It is the pictographs that are banned.
const EMOJI_RANGES = [
    [0x1F000, 0x1FAFF],  // pictographs, faces, symbols, flags
    [0x2600, 0x27BF],    // misc symbols + dingbats (\u2696 \u2601 \u26a1 \u2728 \u2709 \u2699)
    [0x2B00, 0x2BFF],    // arrows-as-pictographs, stars
    [0xFE0F, 0xFE0F],    // variation selector-16 \u2014 the "render as emoji" flag
];

function findEmoji(text) {
    const found = new Set();
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        if (EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) found.add(ch);
    }
    return [...found];
}

test('no emoji in any page, header or footer', () => {
    const offenders = [];
    const check = (where, value) => {
        const hits = findEmoji(JSON.stringify(value));
        if (hits.length) offenders.push(`${where}: ${hits.join(' ')}`);
    };
    for (const page of PAGES) {
        check(`/${page.slug} blocks`, page.blocks);
        check(`/${page.slug} seo`, page.seo || {});
    }
    // `?? site.site?.header` would have been a silent pass: JSON.stringify of
    // undefined is the string "undefined", which contains no emoji. Reach for
    // the real path and let it throw if the bundle shape ever moves.
    const { chrome } = buildBundle().site;
    check('header', chrome.header);
    check('footer', chrome.footer);
    check('announcement', chrome.announcement);
    check('cookieBanner', chrome.cookieBanner);
    assert.deepStrictEqual(offenders, [],
        'use a Lucide icon name instead \u2014 emoji render in the visitor\u2019s OS font');
});

test('the footer columns are balanced \u2014 no dumping ground', () => {
    const { footer } = buildBundle().site.chrome;
    const counts = (footer.columns || []).map(c => ({ heading: c.heading, n: (c.links || []).length }));
    assert.ok(counts.length >= 4, 'the footer needs real columns');
    const tallest = Math.max(...counts.map(c => c.n));
    const shortest = Math.min(...counts.map(c => c.n));
    // "Product" once held eleven links beside a "Source" that held three. A
    // column four times its neighbour is not a category, it is everything
    // that did not fit elsewhere, and the grid goes ragged under it.
    assert.ok(tallest <= shortest * 2,
        `footer columns are lopsided: ${counts.map(c => `${c.heading}=${c.n}`).join(', ')}`);
    assert.ok(tallest <= 8, 'a footer column past eight links wants splitting');
});

test('the announcement bar and cookie banner reach the public payload', async () => {
    const { siteId } = await cmsStore.importSite(bundle);
    const eff = await cmsStore.getEffective(siteId, '', 'en');
    assert.strictEqual(eff.announcement.enabled, true);
    // Assert the SHAPE, not the wording. This used to pin /fair-code/, which
    // is marketing copy — so rewording the one banner that appears on all
    // twenty pages failed a test that was not actually about correctness.
    // What matters is that it survives import with a message and a working
    // link, because a banner with an empty message renders as a bare strip.
    const msg = eff.announcement.text.en;
    assert.ok(msg.message.trim().length > 20, 'the banner needs a real message');
    assert.ok(msg.linkLabel.trim(), 'a banner with no link label is a dead end');
    assert.match(msg.linkUrl, /^\//, 'the banner link must be an internal path');
    assert.strictEqual(eff.cookieBanner.enabled, true);
});

test('the theme lands intact — sanitizeDesign coerces silently, so this is the only check', async () => {
    const { siteId } = await cmsStore.importSite(bundle);
    const eff = await cmsStore.getEffective(siteId, '', 'en');

    assert.strictEqual(eff.design.preset, 'european-warmth');
    assert.strictEqual(eff.design.colors.primary, '#F5A623');
    assert.strictEqual(eff.design.fonts.heading, 'Fraunces');
    assert.strictEqual(eff.design.components.buttonTextColor, 'dark');
    assert.strictEqual(eff.design.layout.containerWidth, 'default');
    assert.strictEqual(eff.design.logo, KEYS.logo);
    assert.strictEqual(eff.design.favicon, KEYS.favicon);
});

test('re-exporting the seeded site reproduces the same content', async () => {
    const { siteId } = await cmsStore.importSite(bundle);
    const reExported = await cmsStore.exportSite(siteId);

    assert.strictEqual(reExported.version, 2);
    assert.deepStrictEqual(
        reExported.site.pages.map(p => p.slug),
        bundle.site.pages.map(p => p.slug),
    );
    assert.deepStrictEqual(
        reExported.site.pages.map(p => p.blocks.map(b => b.type)),
        bundle.site.pages.map(p => p.blocks.map(b => b.type)),
        'a block that changed type or vanished between import and export is a store bug',
    );
    // Ids necessarily differ; content must not.
    const heroIn = bundle.site.pages[0].blocks[0].content;
    const heroOut = reExported.site.pages[0].blocks[0].content;
    assert.deepStrictEqual(heroOut.titleParts, heroIn.titleParts);
    assert.deepStrictEqual(heroOut.mockup.chatBubbles, heroIn.mockup.chatBubbles);
});

// ── Roadmap ─────────────────────────────────────────────
//
// A roadmap is the easiest page on a marketing site to quietly lie on, so
// the two ways it goes wrong are pinned here rather than left to review.

function flattenStrings(node, prefix = '', out = {}) {
    if (typeof node === 'string') { out[prefix] = node; return out; }
    if (Array.isArray(node)) { node.forEach((v, i) => flattenStrings(v, `${prefix}[${i}]`, out)); return out; }
    if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) flattenStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
}

test('every roadmap item carries a status the renderer can bucket', () => {
    // Roadmap.jsx groups on these four values. Anything else lands in the
    // fallback bucket — the item still renders, but under the wrong heading,
    // which on this page means saying something untrue about what ships.
    const ALLOWED = ['shipped', 'beta', 'building', 'exploring'];
    const offenders = [];
    for (const page of PAGES) {
        for (const block of page.blocks) {
            if (block.type !== 'roadmap') continue;
            for (const item of block.content.items || []) {
                if (!ALLOWED.includes(item.status)) {
                    offenders.push(`${page.slug}: "${item.title}" -> ${JSON.stringify(item.status)}`);
                }
            }
        }
    }
    assert.deepStrictEqual(offenders, [], `roadmap status must be one of ${ALLOWED.join(' | ')}`);
});

test('the roadmap promises no dates', () => {
    // terms.md:88 disclaims uninterrupted operation. A printed quarter or
    // year on a public roadmap reads as a commitment we have explicitly
    // not made — and it is the first thing a missed deadline gets quoted
    // back at us. Same shape as the no-currency-symbol rule above.
    const DATEY = /\bQ[1-4]\b|\b20\d\d\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
    const offenders = [];
    for (const page of PAGES) {
        for (const block of page.blocks) {
            if (block.type !== 'roadmap') continue;
            for (const [key, value] of Object.entries(flattenStrings(block.content))) {
                if (DATEY.test(value)) offenders.push(`${page.slug} ${key}: ${value}`);
            }
        }
    }
    assert.deepStrictEqual(offenders, [], 'the roadmap must not carry a date, quarter or year');
});

test('the roadmap states the limitation on every gated item', () => {
    // The `note` is where "Enterprise plan", "opt-in" and "Dutch law only"
    // live. Without it a beta feature reads as generally available, which is
    // the exact misreading this page exists to prevent.
    const page = PAGES.find(p => p.slug === 'roadmap');
    assert.ok(page, 'the roadmap page must exist');
    const block = page.blocks.find(b => b.type === 'roadmap');
    assert.ok(block, 'the roadmap page must carry a `roadmap` block');

    const missing = (block.content.items || [])
        .filter(i => i.status === 'beta' && !String(i.note || '').trim())
        .map(i => i.title);
    assert.deepStrictEqual(missing, [], 'every beta item needs a note saying what it costs and what it does not cover');

    // And the page must not claim a marketplace that does not exist.
    const copy = JSON.stringify(block.content).toLowerCase();
    for (const claim of ['sell your own module', 'publish your module', 'revenue share']) {
        assert.ok(!copy.includes(claim), `"${claim}" is not supported by any code today`);
    }
});

// ── Claims that are checkable, and were wrong ──────────────────────────
//
// These exist because the site started contradicting itself. /sovereignty says
// the PII detector is optional and that prompts go out as typed when it is not
// installed; three older pages said "every outbound prompt is inspected". Both
// cannot be true, and the one a prospect can disprove in a single command is
// the one that costs us.
//
// A literal banned-phrase list rather than a clever heuristic: precise, no
// false positives, and each entry says what to write instead.

const BANNED_PHRASES = [
    // Absolutes about a detector that is an optional service and fails OPEN
    // when it is not installed (server/core/piiDetection.js:528-537).
    ['every outbound prompt', 'the PII guard is optional \u2014 say "once the detector is installed"'],
    ['every prompt is scanned', 'same: the guard is an optional service'],
    ['all prompts are scanned', 'same: the guard is an optional service'],

    // Zero-knowledge covers chat and notebook conversations. Knowledge bases
    // and meeting transcripts are stored server-readable and the docs say so.
    ['no master key exists', 'scope it: which data? KB and transcripts are server-readable'],
    ['never leave your storage', 'scope it \u2014 unqualified, this is not true of every store'],

    // terms.md:88 disclaims uninterrupted operation, and support SLAs in this
    // product are a CUSTOMER-configurable feature, not our commitment.
    ['within minutes', 'no response-time promises \u2014 terms.md disclaims them'],
    ['highly available', 'no availability claims'],
    ['high availability', 'no availability claims'],
    // Not a bare 'uptime': /cloud says "there is no published uptime
    // percentage and no service level agreement", which is exactly the
    // copy we want. Ban the promise forms only.
    ['% uptime', 'no uptime claims'],
    ['uptime guarantee', 'no uptime claims'],
    ['uptime sla', 'no uptime claims'],
    ['guaranteed response', 'no response-time promises'],
    ['24/7', 'no availability claims'],
];

test('no page makes a claim the product cannot keep', () => {
    const offenders = [];
    for (const page of PAGES) {
        const copy = JSON.stringify(page.blocks).toLowerCase()
            + ' ' + JSON.stringify(page.seo || {}).toLowerCase();
        for (const [phrase, why] of BANNED_PHRASES) {
            if (copy.includes(phrase)) offenders.push(`${page.slug}: "${phrase}" \u2014 ${why}`);
        }
    }
    assert.deepStrictEqual(offenders, [], 'these claims are contradicted elsewhere on the site');
});

// The comparison pages are the only ones that describe someone else's product,
// and they are read by people who use that product daily. Two failure modes
// matter: quoting a competitor's commercial terms (which change, leaving us
// wrong in public and looking like we are trying to mislead), and absolute
// claims about what a competitor cannot do (which are almost never checkable
// and are exactly what a knowledgeable reader disproves in one line).
//
// Scoped to the comparison pages on purpose. "Cheaper" is a perfectly fine word
// on /pricing about our own product; it is a liability on /zapier-alternative.
// Deliberately narrow. A first draft banned bare "cost" and bare "worse" and
// produced four false positives on copy that was doing the right thing — "it
// would cost you more time than rebuilding" (time, not money), "a real cost
// rather than a footnote" (our own operational burden), and two sentences
// explicitly DENYING that a competitor is worse. Same lesson as the 'uptime'
// entry above: ban the assertion, not the word. A guard that cries wolf gets
// switched off, which is worse than not having it.
const COMPETITOR_CLAIMS = [
    [/\bper (?:user|seat) per (?:month|year)\b/i, 'no competitor pricing — link to their pricing page instead'],
    [/\b(?:cheaper|more expensive|costs? (?:less|more)) than\b/i,
        'no price comparisons — their packaging changes and ours is not authoritative'],
    [/\bpricing starts (?:at|from)\b/i, 'no competitor pricing'],
    [/\b(?:they|it) (?:cannot|can’t|can't|do not|don’t|doesn’t|does not) (?:support|offer|handle)\b/i,
        'absolute claims about a competitor age badly — describe what WE do instead'],
    [/\b(?:the only|no other) (?:platform|product|tool|vendor)\b/i,
        'unfalsifiable superiority claim — name the specific capability instead'],
    [/\b(?:inferior|clunky|outdated|bloated|primitive)\b/i,
        'no disparagement — the rules at the top of the comparison section forbid it'],
];

test('no comparison page says something about a competitor we would regret', () => {
    const offenders = [];
    for (const page of PAGES) {
        if (!/-alternative$/.test(page.slug) && page.slug !== 'compare') continue;
        const copy = JSON.stringify(page.blocks) + ' ' + JSON.stringify(page.seo || {});
        for (const [re, why] of COMPETITOR_CLAIMS) {
            const hit = copy.match(re);
            if (hit) offenders.push(`${page.slug}: "${hit[0]}" — ${why}`);
        }
    }
    assert.deepStrictEqual(offenders, [], 'these would embarrass us in front of an informed reader');
});

// Every comparison page must route back to the hub, and the hub must reach all
// of them. Without this the set silently degrades into orphans as pages are
// added: the hub is the only page linking them to each other.
test('the comparison set stays connected to its hub', () => {
    const compare = PAGES.find(p => p.slug === 'compare');
    assert.ok(compare, 'the /compare hub must exist');

    const others = PAGES.filter(p => /-alternative$/.test(p.slug));
    assert.ok(others.length >= 7, `expected at least 7 comparison pages, found ${others.length}`);

    const hubCopy = JSON.stringify(compare.blocks);
    const missing = others
        .filter(p => !hubCopy.includes(`/${p.slug}`))
        .map(p => p.slug);
    assert.deepStrictEqual(missing, [], 'the hub does not link these comparison pages');

    const orphans = others
        .filter(p => !JSON.stringify(p.blocks).includes("'compare'")
                  && !JSON.stringify(p.blocks).includes('"compare"'))
        .map(p => p.slug);
    assert.deepStrictEqual(orphans, [], 'these comparison pages never link back to /compare');
});

// The clamp in core/seo/head.js used to be wider than the editor's counters,
// so a title could survive authoring here and still be cut with an ellipsis in
// the served HTML. Importing the server's own budgets makes the seed the
// third copy of the same truth — and this test the thing that keeps it so.
test('every metaTitle and metaDescription fits the served budget, exactly once', () => {
    const { TITLE_MAX, DESC_MAX } = require('../../core/seo/head');
    const problems = [];
    const seenTitles = new Map();
    for (const page of PAGES) {
        const t = String(page.seo?.metaTitle || '');
        const d = String(page.seo?.metaDescription || '');
        if (!t.trim()) problems.push(`${page.slug}: empty metaTitle`);
        if (!d.trim()) problems.push(`${page.slug}: empty metaDescription`);
        if (t.length > TITLE_MAX) problems.push(`${page.slug}: metaTitle ${t.length} > ${TITLE_MAX}`);
        if (d.length > DESC_MAX) problems.push(`${page.slug}: metaDescription ${d.length} > ${DESC_MAX}`);
        if (seenTitles.has(t)) problems.push(`${page.slug}: metaTitle duplicates ${seenTitles.get(t)}`);
        else seenTitles.set(t, page.slug);
    }
    assert.deepStrictEqual(problems, [], 'SERP snippets must never be truncated or shared');
});

// One publish used to stamp `publishedAt` on every sitemap URL, so a crawler
// could never tell an edited page from an untouched one. The snapshot now
// carries per-page content hashes; this pins the three behaviours that make
// them useful: complete on publish, stable over an unchanged republish, and
// moved only for the page that actually changed.
test('per-page lastmod: complete, stable, and only bumped by real edits', async () => {
    const { siteId } = await cmsStore.importSite(bundle);
    await cmsStore.publishSite(siteId);
    const first = await cmsStore.getPublishedSnapshot(siteId);
    const ids = Object.keys(first.pages);
    assert.strictEqual(Object.keys(first.pageMeta || {}).length, ids.length,
        'every published page carries pageMeta');

    await cmsStore.publishSite(siteId);
    const second = await cmsStore.getPublishedSnapshot(siteId);
    for (const id of ids) {
        assert.strictEqual(second.pageMeta[id].lastModifiedAt, first.pageMeta[id].lastModifiedAt,
            `an unchanged republish must not re-date page ${id}`);
    }

    const target = ids[0];
    const page = await cmsStore.getPage(siteId, target);
    page.blocks[0].content = { ...page.blocks[0].content, eyebrow: 'Edited for the lastmod test' };
    await cmsStore.setPage(siteId, page);
    await cmsStore.publishSite(siteId);
    const third = await cmsStore.getPublishedSnapshot(siteId);
    assert.notStrictEqual(third.pageMeta[target].lastModifiedAt, second.pageMeta[target].lastModifiedAt,
        'the edited page must move');
    for (const id of ids.filter(i => i !== target)) {
        assert.strictEqual(third.pageMeta[id].lastModifiedAt, second.pageMeta[id].lastModifiedAt,
            `untouched page ${id} must not move with it`);
    }
});

// A page whose slug appears in LEGACY_SLUGS is unreachable: publicRender 301s
// the request away before the page is ever resolved. Nothing else would
// catch this — the import succeeds, the sitemap lists it, and every visit
// silently lands somewhere else.
test('no page sits on a slug the redirect map already owns', () => {
    const { LEGACY_SLUGS } = require('../../core/seo/legacySlugs');
    const clashes = PAGES.map(p => p.slug).filter(s => LEGACY_SLUGS[s]);
    assert.deepStrictEqual(clashes, [], 'these pages would be permanently 301ed away');
});

test('the site chrome makes the same promises the pages do', () => {
    // The footer and announcement render on all 20 pages, so a claim here is
    // twenty claims.
    const chrome = JSON.stringify(bundle.site.chrome).toLowerCase();
    const offenders = BANNED_PHRASES
        .filter(([phrase]) => chrome.includes(phrase))
        .map(([phrase, why]) => `chrome: "${phrase}" \u2014 ${why}`);
    assert.deepStrictEqual(offenders, []);
});

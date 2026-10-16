// @typecheck
/**
 * CMS builder — draft-wide validation for the AI feedback loop.
 *
 * validateSiteDraft(draftWrap) → { ok, errors, warnings } where each record
 * is { code, path, message, hint } (the same shape the app-studio builder
 * feeds back to the model). Runs after every mutation in the builder turn;
 * errors go back to the model as a machine message AND to the client as a
 * validation_errors SSE event.
 *
 * Checks:
 *   errors:   dangling_page_link  — a {kind:'page'} link to a nonexistent page
 *             duplicate_slug      — two pages sharing a slug
 *             reserved_slug       — a slug that collides with app routes
 *   warnings: empty_page          — a page with zero blocks
 *             unknown_icon        — an icon value that is not a Lucide
 *                                   PascalCase name (renderers show nothing).
 *                                   Page blocks only: header/footer chrome
 *                                   (mega-menu items) may hold legacy emoji,
 *                                   so those trees skip the name check.
 *             invalid_icon_asset  — an icon that looks like an address (cms/… or /…)
 *                                   but is not an uploaded asset (any tree)
 *             bad_color           — a design colour that is not #rrggbb
 *             unknown_font        — a design font outside the loadable library
 *             low_contrast        — a design colour pair below WCAG AA (4.5:1)
 *             heavy_hero_image, autoplay_video, many_media — page speed (validateMedia.js)
 *             demo_poster_not_text, demo_caption_not_text — feature-demo poster/caption (validateBlocks.js)
 *
 * The three design checks are WARNINGS, never errors, per this file's
 * doctrine: cmsStore.sanitizeDesign() coerces instead of rejecting, so these
 * catch what it silently swallowed (a bad hex renders as "no colour", an
 * unloadable font falls back to the system stack) plus the one thing nothing
 * else can catch — a legal-but-unreadable palette a human typed in the
 * Design tab. cms_update_design itself hard-rejects bad input before it can
 * ever land, so in practice these fire on hand-edited or imported designs.
 */

'use strict';

const { sanitizeBlockDesignStyle, cleanAnchor, BLOCK_DESIGN_STYLE_KEYS, MEDIA_HEIGHTS, MEDIA_FITS } = require('../i18n/defaults/blockStyleEnums');
const { BLOCK_VARIANTS, DEMO_FEATURE_IDS, COLOR_KEYS, BLANKABLE_COLORS, DARK_COLOR_KEYS, DESIGN_FONTS } = require('../i18n/defaults/cmsDefaults');
const { checkTabs, checkStoryHeader, checkScrollStory, checkFeatureDemo } = require('./validateBlocks');
const { slugProblem } = require('../stores/cms/slugRules');
const { checkPageMedia } = require('./validateMedia');
const { safeIconAsset } = require('../stores/cms/localeMedia');
const { experimentWarnings } = require('./experiments');

// Lucide component names are PascalCase ASCII (Star, ShieldCheck, BarChart3).
const LUCIDE_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_ROLES = ['heading', 'body', 'mono'];
// WCAG 2.1 AA for normal-size body text.
const AA_RATIO = 4.5;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── Contrast (local, tiny — the admin-side colorUtils.contrastRatio lives in
//    the agent-hub bundle and must not be imported across the boundary) ──

/** sRGB relative luminance per WCAG 2.1; null for anything not #rrggbb. */
function relativeLuminance(hex) {
    if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
    const channel = (i) => {
        const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio (1–21); null when either colour is unparseable. */
function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The label colour the renderer paints on a primary button, per
 * design.components.buttonTextColor. 'auto' resolves from the primary's own
 * luminance (L > 0.45 → near-black), the same rule applyDesignToRoot uses.
 */
function resolveButtonLabel(buttonTextColor, primary) {
    if (buttonTextColor === 'dark') return '#0B0B0C';
    if (buttonTextColor === 'auto') {
        const l = relativeLuminance(primary);
        if (l === null) return null;
        return l > 0.45 ? '#0B0B0C' : '#FFFFFF';
    }
    return '#FFFFFF'; // 'light' (the default) and anything unknown
}

/** Design-level warnings: bad_color, unknown_font, low_contrast. */
function checkDesign(design, warnings) {
    const d = isPlainObject(design) ? design : {};
    const colors = isPlainObject(d.colors) ? d.colors : {};
    const darkColors = isPlainObject(d.darkColors) ? d.darkColors : {};
    const fonts = isPlainObject(d.fonts) ? d.fonts : {};
    const components = isPlainObject(d.components) ? d.components : {};

    /** @type {Array<[string, Record<string, unknown>, string[], string[]]>} */
    const colorGroups = [
        ['colors', colors, COLOR_KEYS, BLANKABLE_COLORS],
        // darkColors.primary/accent use '' for "reuse the light value".
        ['darkColors', darkColors, DARK_COLOR_KEYS, ['primary', 'accent']],
    ];
    for (const [group, values, keys, blankable] of colorGroups) {
        for (const key of keys) {
            const v = values[key];
            if (v === undefined || (v === '' && blankable.includes(key))) continue;
            if (typeof v !== 'string' || !HEX_RE.test(v)) {
                warnings.push({
                    code: 'bad_color',
                    path: `site.design.${group}.${key}`,
                    message: `design.${group}.${key} ${JSON.stringify(v ?? null)} is not a "#rrggbb" hex colour.`,
                    hint: 'Set it with cms_update_design — every colour must be a 6-digit hex string like "#1C1917". The renderer ignores anything else.',
                });
            }
        }
    }

    for (const role of FONT_ROLES) {
        const face = fonts[role];
        if (typeof face !== 'string' || !face || DESIGN_FONTS.includes(face)) continue;
        warnings.push({
            code: 'unknown_font',
            path: `site.design.fonts.${role}`,
            message: `Font ${JSON.stringify(face)} is not in the site's font library, so it falls back to the system stack.`,
            hint: `Pick one with cms_update_design fontsPatch: ${DESIGN_FONTS.join(', ')}.`,
        });
    }

    const bodyRatio = contrastRatio(colors.textPrimary, colors.background);
    if (bodyRatio !== null && bodyRatio < AA_RATIO) {
        warnings.push({
            code: 'low_contrast',
            path: 'site.design.colors.textPrimary',
            message: `Body text ${colors.textPrimary} on background ${colors.background} is ${bodyRatio.toFixed(2)}:1 — below the WCAG AA minimum of ${AA_RATIO}:1.`,
            hint: 'Darken textPrimary or lighten background with cms_update_design colorsPatch until the pair reaches 4.5:1.',
        });
    }

    const label = resolveButtonLabel(components.buttonTextColor, colors.primary);
    const btnRatio = contrastRatio(label, colors.primary);
    if (btnRatio !== null && btnRatio < AA_RATIO) {
        warnings.push({
            code: 'low_contrast',
            path: 'site.design.colors.primary',
            message: `The primary button label ${label} on ${colors.primary} is ${btnRatio.toFixed(2)}:1 — below the WCAG AA minimum of ${AA_RATIO}:1.`,
            hint: 'Flip components.buttonTextColor (light | dark | auto) or darken the primary colour with cms_update_design.',
        });
    }
}

/**
 * Walk a value tree calling visit(node, path) on every plain object.
 * Arrays contribute `[i]` segments, objects `.key` segments.
 */
function walk(node, path, visit) {
    if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`, visit));
        return;
    }
    if (!isPlainObject(node)) return;
    visit(node, path);
    for (const [k, v] of Object.entries(node)) {
        walk(v, `${path}.${k}`, visit);
    }
}

function validateSiteDraft(draftWrap) {
    const errors = [];
    const warnings = [];
    const site = draftWrap?.site;
    if (!isPlainObject(site)) {
        return { ok: false, errors: [{ code: 'no_site', path: 'site', message: 'No site loaded.', hint: 'Internal — reload the builder.' }], warnings };
    }

    const pageEntries = Array.isArray(site.pages) ? site.pages : [];
    const knownIds = new Set(pageEntries.map((p) => p.id));
    const knownIdsHint = `Known page ids: ${pageEntries.map((p) => `${p.id} (${p.slug})`).join(', ') || '(none)'}.`;

    // ── Slug checks (the store dedupes on write, but imports/legacy data
    //    can still carry collisions — and the model should hear about them). ──
    const bySlug = new Map();
    for (const entry of pageEntries) {
        if (!entry || typeof entry.slug !== 'string') continue;
        if (bySlug.has(entry.slug)) {
            errors.push({
                code: 'duplicate_slug',
                path: `pages.${entry.id}`,
                message: `Slug "${entry.slug}" is used by both ${bySlug.get(entry.slug)} and ${entry.id}.`,
                hint: 'Give one of the pages a different slug with cms_update_page_meta.',
            });
        } else {
            bySlug.set(entry.slug, entry.id);
        }
        const problem = slugProblem(entry.slug);
        if (problem?.code === 'reserved') {
            errors.push({
                code: 'reserved_slug',
                path: `pages.${entry.id}`,
                message: problem.message,
                hint: 'Rename the page slug with cms_update_page_meta.',
            });
        } else if (problem) {
            warnings.push({
                code: 'unroutable_slug',
                path: `pages.${entry.id}`,
                message: problem.message,
                hint: 'Rename the page slug with cms_update_page_meta; until then the page is not reachable.',
            });
        }
    }

    // ── Link + icon walk over site chrome and every loaded page. The icon
    //    name check is opt-out: header/footer chrome may hold legacy emoji. ──
    // An address-shaped icon must be an uploaded asset; a name is checked as
    // Lucide only where the tree is not exempt (chrome keeps legacy emoji).
    const iconWarning = (icon, path, checkName) => {
        if (icon.startsWith('cms/') || icon.startsWith('/')) {
            if (safeIconAsset(icon)) return;
            warnings.push({
                code: 'invalid_icon_asset',
                path: `${path}.icon`,
                message: `Icon ${JSON.stringify(icon)} is not an uploaded asset of this site, so no icon is shown.`,
                hint: 'Use a Lucide name, or the url of an uploaded file from cms_list_assets (cms/<file> or /api/cms/asset/cms/<file>).',
            });
        } else if (checkName && !LUCIDE_NAME_RE.test(icon)) {
            warnings.push({
                code: 'unknown_icon',
                path: `${path}.icon`,
                message: `Icon ${JSON.stringify(icon)} does not look like a Lucide icon name.`,
                hint: 'Icons are Lucide PascalCase names, e.g. Star, Zap, ShieldCheck, BarChart3, or an uploaded asset url.',
            });
        }
    };
    const checkTree = (root, rootPath, { checkIcons = true } = {}) => {
        walk(root, rootPath, (node, path) => {
            if (node.kind === 'page' && typeof node.pageId === 'string' && !knownIds.has(node.pageId)) {
                errors.push({
                    code: 'dangling_page_link',
                    path,
                    message: `Link points at nonexistent page ${JSON.stringify(node.pageId)}.`,
                    hint: `Point it at a real page or switch to an external/anchor link. ${knownIdsHint}`,
                });
            }
            if (typeof node.icon === 'string' && node.icon) iconWarning(node.icon, path, checkIcons);
        });
    };

    checkTree(site.header, 'site.header', { checkIcons: false });
    checkTree(site.footer, 'site.footer', { checkIcons: false });

    // ── Design: warnings only (see the doctrine note in the file header). ──
    checkDesign(site.design, warnings);

    const pages = draftWrap.pages instanceof Map ? draftWrap.pages : new Map();
    for (const entry of pageEntries) {
        const doc = pages.get(entry.id);
        if (!doc) continue; // not loaded this turn — nothing to inspect
        const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
        if (blocks.length === 0) {
            warnings.push({
                code: 'empty_page',
                path: `pages.${entry.id}`,
                message: `Page "${entry.title || entry.slug}" has no blocks yet.`,
                hint: 'Add content with cms_add_blocks, or leave it if the user wants it empty.',
            });
        }
        checkPageMedia(entry.id, entry.title || entry.slug, blocks, warnings);
        blocks.forEach((b, i) => {
            checkTree(b?.content, `pages.${entry.id}.blocks[${i}].content`);
            // Layout variant sanity — an unknown variant renders as the
            // type's default layout, so this is a warning (self-correct),
            // never an error.
            const variant = b?.content?.variant;
            if (typeof variant === 'string' && variant) {
                const allowed = BLOCK_VARIANTS[b?.type];
                if (Array.isArray(allowed) && !allowed.includes(variant)) {
                    warnings.push({
                        code: 'unknown_variant',
                        path: `pages.${entry.id}.blocks[${i}].content.variant`,
                        message: `Variant ${JSON.stringify(variant)} is not valid for block type "${b.type}".`,
                        hint: `Allowed variants for ${b.type}: ${allowed.join(', ')}. Unknown values render as '${allowed[0]}'.`,
                    });
                }
            }
            // Bento card media box: unknown values render as the identity
            // (the whole image at its own ratio).
            if (b?.type === 'features' && Array.isArray(b?.content?.items)) {
                b.content.items.forEach((item, j) => {
                    /** @type {Array<[string, string[]]>} */
                    const checks = [['mediaHeight', MEDIA_HEIGHTS], ['mediaFit', MEDIA_FITS]];
                    for (const [key, allowedVals] of checks) {
                        const v = item?.[key];
                        if (v === undefined || v === '' || allowedVals.includes(v)) continue;
                        warnings.push({
                            code: 'unknown_item_value',
                            path: `pages.${entry.id}.blocks[${i}].content.items[${j}].${key}`,
                            message: `items[${j}].${key} ${JSON.stringify(v)} is not a known value.`,
                            hint: `Allowed: ${allowedVals.join(', ')}. Invalid values are ignored by the renderer.`,
                        });
                    }
                });
            }
            // Live feature demo — the block frames a real product UI chosen by
            // ID, and the renderer shows a placeholder for anything it does not
            // recognise. That fails safe (it can never become an embed of some
            // other origin) but it fails SILENTLY: the page just carries a dead
            // panel. Warn so the author finds out before a visitor does.
            if (b?.type === 'feature-demo') {
                const demoFeature = b?.content?.feature;
                if (!demoFeature || !DEMO_FEATURE_IDS.includes(demoFeature)) {
                    warnings.push({
                        code: 'unknown_demo_feature',
                        path: `pages.${entry.id}.blocks[${i}].content.feature`,
                        message: demoFeature
                            ? `No live demo is registered for ${JSON.stringify(demoFeature)}.`
                            : 'This live-demo block has no feature selected.',
                        hint: `Available demos: ${DEMO_FEATURE_IDS.join(', ')}. Anything else renders an explanatory placeholder instead of the demo.`,
                    });
                }
                checkFeatureDemo(b.content, `pages.${entry.id}.blocks[${i}].content`, warnings);
            }
            if (b?.type === 'tabs') checkTabs(b.content, `pages.${entry.id}.blocks[${i}].content`, warnings);
            if (b?.type === 'scrollStory') checkScrollStory(b.content, `pages.${entry.id}.blocks[${i}].content`, warnings);
            if (b?.type === 'story-header') checkStoryHeader(b.content, `pages.${entry.id}.blocks[${i}].content`, warnings);
            warnings.push(...experimentWarnings(b, `pages.${entry.id}.blocks[${i}].content`));
            // Style v2 enum sanity — invalid values are ignored by the
            // renderer, so warnings only (the model self-corrects).
            const st = b?.style;
            if (st && typeof st === 'object') {
                const styleEnums = {
                    band:    ['default', 'surface', 'tint', 'dark', 'primary'],
                    rhythm:  ['tight', 'compact', 'default', 'spacious'],
                    reveal:  ['on', 'off'],
                };
                for (const [key, allowedVals] of Object.entries(styleEnums)) {
                    const v = st[key];
                    if (v !== undefined && v !== '' && !allowedVals.includes(v)) {
                        warnings.push({
                            code: 'unknown_style_value',
                            path: `pages.${entry.id}.blocks[${i}].style.${key}`,
                            message: `style.${key} ${JSON.stringify(v)} is not a known value.`,
                            hint: `Allowed: ${allowedVals.join(', ')}. Invalid values are ignored by the renderer.`,
                        });
                    }
                }
                // Design keys (background placement, brand motif): the store drops
                // an illegal value on save, so say which one went.
                const cleaned = sanitizeBlockDesignStyle(st);
                for (const key of Object.keys(st)) {
                    if (key in cleaned || !BLOCK_DESIGN_STYLE_KEYS.includes(key)) continue;
                    if (key === 'backgroundImage' || key === 'backgroundOverlay') continue;
                    warnings.push({
                        code: 'unknown_style_value',
                        path: `pages.${entry.id}.blocks[${i}].style.${key}`,
                        message: `style.${key} ${JSON.stringify(st[key])} is not a known value and is dropped on save.`,
                        hint: 'backgroundSize: cover | contain | auto | "<n>px"; backgroundPosition: the nine anchors (top-left … bottom-right); backgroundRepeat: no-repeat | repeat | repeat-x | repeat-y; motif: none | honeycomb; motifSide: right | left | center; decor: default | none; cardFill: tint | white | none; labelStyle: mono | plain; tileShape: default | square | rounded | circle | hexagon; tileFill: default | tint | solid | none; tileSize: default | sm | lg; tileIconColor: default | light | dark; backgroundHideMobile / motifTiles: true | false.',
                    });
                }
                if (st.anchor !== undefined) {
                    const slug = cleanAnchor(st.anchor);
                    const twin = slug ? blocks.findIndex((o) => o?.style?.anchor === st.anchor) : -1;
                    if (!slug || (twin >= 0 && twin < i)) {
                        warnings.push({
                            code: slug ? 'duplicate_anchor' : 'unknown_style_value',
                            path: `pages.${entry.id}.blocks[${i}].style.anchor`,
                            message: slug ? `style.anchor ${JSON.stringify(st.anchor)} is already used by an earlier block on this page.` : `style.anchor ${JSON.stringify(st.anchor)} is not a valid slug.`,
                            hint: 'Anchors are unique per page: lowercase letters, digits and single hyphens, starting with a letter.',
                        });
                    }
                }
                if (st.columns !== undefined && ![2, 3, 4].includes(Number(st.columns))) {
                    warnings.push({
                        code: 'unknown_style_value',
                        path: `pages.${entry.id}.blocks[${i}].style.columns`,
                        message: `style.columns ${JSON.stringify(st.columns)} is not a known value.`,
                        hint: 'Allowed: 2, 3, 4 (features/steps/security/techStats grids only). Invalid values are ignored.',
                    });
                }
            }
        });
    }

    return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateSiteDraft };
// Internals exposed for unit tests.
module.exports._test = { contrastRatio, relativeLuminance, resolveButtonLabel };

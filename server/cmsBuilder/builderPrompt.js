/**
 * CMS builder — system prompt + draft-state rendering.
 *
 * PROMPT-CACHE DISCIPLINE (same contract as appStudio/builderPrompt.js):
 * buildSystemPrompt() is STATIC and byte-stable across turns — the block
 * catalogue is rendered once per process from i18n/defaults/cmsDefaults.js —
 * so provider prompt caches (Anthropic system breakpoint, OpenAI prefix
 * cache) keep hitting while the user iterates. The LIVE site state (which
 * changes every turn) is rendered by renderDraftState() and travels in a
 * LATE role:'user' machine message instead — it must never be baked into
 * the system prompt.
 */

'use strict';

const {
    BLOCK_DEFAULTS, BLOCK_TYPES, BLOCK_VARIANTS,
    DESIGN_COMPONENT_ENUMS, DESIGN_LAYOUT_ENUMS, DESIGN_THEMES, DESIGN_MOTIONS,
    DISPLAY_SIZES, HEADING_WEIGHTS, BODY_SIZES, COLOR_KEYS, DARK_COLOR_KEYS, DESIGN_FONTS,
} = require('../i18n/defaults/cmsDefaults');
const { THEME_PRESETS } = require('../i18n/defaults/themePresets');

// ---------------------------------------------------------------------------
// Catalogue — rendered ONCE per process (byte-stable)
// ---------------------------------------------------------------------------

function renderCatalogText() {
    const lines = [];
    for (const t of BLOCK_TYPES) {
        lines.push(`### ${t.type} — ${t.label} (${t.category})`);
        lines.push('Default content (your `content` deep-merges over this; arrays replace wholesale):');
        lines.push(JSON.stringify(BLOCK_DEFAULTS[t.type] ?? {}, null, 1));
        const variants = BLOCK_VARIANTS[t.type];
        if (Array.isArray(variants) && variants.length) {
            lines.push(`Allowed \`content.variant\` values: ${variants.join(' | ')} (absent/unknown renders as '${variants[0]}').`);
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

const CATALOG_TEXT = renderCatalogText();

// Design vocabulary — also rendered ONCE per process from the schema-of-record
// constants, so the ## Design section stays byte-stable across turns (never
// interpolate draftWrap here: the live design travels in renderDraftState).
const enumLine = (enums) => Object.entries(enums).map(([k, v]) => `${k} (${v.join(' | ')})`).join(', ');
const PRESET_TEXT = THEME_PRESETS.map((p) => `${p.id} — ${p.label}`).join('; ');
const DESIGN_FONTS_TEXT = DESIGN_FONTS.join(', ');
const COMPONENTS_TEXT = enumLine(DESIGN_COMPONENT_ENUMS);
const LAYOUT_TEXT = enumLine(DESIGN_LAYOUT_ENUMS);

// ---------------------------------------------------------------------------
// System prompt (byte-stable)
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
    return `You are the BeeFlow website builder. You build and edit pages of a CMS website as STRUCTURED BLOCKS — never code. There is no HTML, CSS or JavaScript here: a page is an ordered list of typed blocks you assemble exclusively through the cms_* tools. Do not describe the site in prose instead of building it — call the tools.

## The content model

- A SITE = settings + design + chrome (header/footer/cookie banner) + an ordered list of PAGES. One page is the homepage (served at "/"); every other page is served at "/<slug>".
- A PAGE = title + slug + seo + an ordered list of BLOCKS. A block is { id, type, enabled, content, style } — the 15 legal types and their default content are in the catalogue below. Blocks render top-to-bottom in array order.
- Adding blocks: your content is DEEP-MERGED over the type's defaults. Objects merge key-by-key; ARRAYS REPLACE WHOLESALE — always send the complete items/columns/stats/logos array, never a partial one (a 1-item array replaces a 3-item default).
- Editing blocks: cms_update_block patches content the same way (arrays replace wholesale). Use enabled:false to hide a block without losing its content.

## Content-shape rules (get these exactly right)

- SHOW/HIDE has three encodings, per field — copy whichever the catalogue shows for that field:
  1. \`enabled\` sub-flags: nested objects like hero.badge, hero.primaryCta, hero.secondaryCta, hero.mockup and live-component.cta carry { enabled: true/false, … } — flip the flag, keep the rest of the object.
  2. null-sentinels: media-text.subheading, media-text.cta and cta-banner.secondaryCta are null when hidden — set null to hide, set the full object/string to show.
  3. sibling flags: hero's lead text is toggled by a sibling boolean \`leadEnabled\` next to \`lead\` (absent = shown).
- \`*Style\` blobs ({ fontFamily, fontSize, color, sometimes fontWeight }) are per-text styling. Empty string / 0 mean "inherit the page CSS and the Design tab" — leave them inherited unless the user asks for specific typography.
- \`*Align\` fields take left | center | right.
- LINKS are always one of: {kind:"page",pageId} (internal — use a REAL pg_… id from the draft state), {kind:"external",url,newTab?}, {kind:"anchor",anchor}, {kind:"app",path} (hands off to the host app). Never write bare href strings.
- ICONS in page blocks are Lucide component names in PascalCase (Star, Zap, ShieldCheck, BarChart3, LifeBuoy). Nothing else renders. (Header mega-menu items are the one exception — see Header menu below.)
- IMAGES (block media src, logos, ogImage) must be an EXISTING cms/… asset key the user already uploaded, or an absolute https:// URL. NEVER invent asset keys — when there is no real image, leave src empty (the renderer shows a placeholder) and tell the user where to upload one.

## How you work

1. The current site state (every page id, slug, title and block outline, plus the full JSON of the page in focus) is injected into the conversation each turn — read ids there; call cms_get_page for any other page's full JSON. Never invent ids.
2. Every successful tool call is saved immediately — there is no separate "save" step. Slugs are normalized and de-duplicated for you; reserved slugs (app, api, admin, login, pricing, privacy, terms, …) are rejected.
3. BATCH block work: one cms_add_blocks call per page area with up to 10 complete blocks, in render order. Write real, on-brand copy from what the user told you — placeholder text only where you genuinely lack information.
4. Edit IN PLACE with cms_update_block. Never remove + re-add a block just to tweak it (removal deletes its translations).
5. Tool results may carry _hints or _fixHint — repairs and corrections to your input. Learn from them; do not resend the repaired mistake. Machine-generated VALIDATION REPORTS may arrive mid-build — fix every error they list, don't apologise to the user about them.
6. Keep replies short. When you finish, tell the user in a sentence or two what changed and where to look.

## Header menu (cms_update_header_nav)

- The public site's header MENU is site chrome, edited with cms_update_header_nav — never with page blocks. The call REPLACES the entire menu wholesale: send every item you want to keep, in render order (max 20 top-level items).
- A menu item = { id?, label, link, children?, dropdown? }. The draft state lists the current items with their nav_… ids — reuse those ids for items you keep (ids anchor locale overrides); omit id on new items and one is minted.
- link uses the same link objects as blocks ({kind:"page",pageId} | {kind:"external",url,newTab?} | {kind:"anchor",anchor} | {kind:"app",path}) — page links need a REAL pg_… id.
- children = a flat dropdown: up to 10 sub-items { id?, label, link }.
- dropdown = a mega menu { columns:[{ id?, heading, items:[{ id?, label, link, description?, icon?, openInNewTab? }] }] } — up to 4 columns of up to 10 items. A mega item's icon is an EMOJI or short text (e.g. 🚀), NOT a Lucide name. For a SIMPLE flat dropdown use "children" instead; only use "dropdown" for a multi-column mega menu.

## Design (cms_update_design)

- The site's THEME — colours, fonts, type scale, component shape/size and the page frame — is site-wide design, edited with cms_update_design, never with page blocks or per-block style overrides. The current design travels in the site state each turn as compact JSON; patch it from there.
- The call is a DEEP-MERGE PATCH: send ONLY what changes. colorsPatch {primary} keeps the other six colours; the groups you omit are untouched. There is no "reset" — to go back to a known look, apply a preset.
- \`preset\` applies a built-in theme's COMPLETE values first, then your other patches layer on top ({ preset:"midnight-flow", colorsPatch:{primary:"#CE3F26"} } = that theme with a custom primary). The themes: ${PRESET_TEXT}.
- COLOURS: colorsPatch { ${COLOR_KEYS.join(', ')} } and darkColorsPatch { ${DARK_COLOR_KEYS.join(', ')} }. Every value is a literal "#rrggbb" hex string — colour names, rgb()/hsl() and 3-digit shorthand are REJECTED and nothing is saved. darkColors.primary and darkColors.accent also take "" meaning "reuse the light value". Translate the user's words into hex yourself ("warm amber" → "#F5A623").
- FONTS: fontsPatch { heading, body, mono }. Only these faces exist — anything else is rejected: ${DESIGN_FONTS_TEXT}.
- typographyPatch { displaySize (${DISPLAY_SIZES.join(' | ')}), headingWeight (${HEADING_WEIGHTS.join(' | ')}), bodySize (${BODY_SIZES.join(' | ')}) }; radius 0-24 (px, global); theme (${DESIGN_THEMES.join(' | ')}); motion (${DESIGN_MOTIONS.join(' | ')}); grain and gradient booleans.
- componentsPatch — ${COMPONENTS_TEXT}.
- layoutPatch — ${LAYOUT_TEXT}.
- The site LOGO and FAVICON are uploaded assets, not design values: you cannot set them here. Ask the user to upload one in the Design tab — never invent an asset key.
- Contrast is your job: dark text on a light background and a readable button label on the primary colour. A low-contrast palette still saves but comes back as a warning you should fix.

## Out of scope (redirect, never fake)

- DELETING pages: you cannot delete a page. Suggest disabling its blocks (cms_update_block enabled:false) or tell the user to delete it in the Pages panel.
- FOOTER and COOKIE BANNER: not editable here yet — point the user at the Site chrome tab. (The header MENU is yours via cms_update_header_nav and the THEME via cms_update_design; the rest of the header — logo, CTA buttons — is Site chrome too.)
- TRANSLATIONS / locale overrides: owned by the AI-translate flow in the admin panel — never write locale content yourself.
- PUBLISHING / going live: never yours. Changes land in the draft; the user reviews and clicks Publish themselves.

## Catalogue (the ONLY block types that exist, with their default content)

${CATALOG_TEXT}

Begin now.`;
}

// ---------------------------------------------------------------------------
// Draft state — compact ID-bearing site rendering (per-turn dynamic context)
// ---------------------------------------------------------------------------

// The page in focus travels as full JSON so the model can patch precisely —
// but capped so a monster page can't blow the context. Over the cap the
// model gets the outline + an instruction to cms_get_page.
const PAGE_JSON_CAP = 12 * 1024;

function q(s, max = 48) {
    const str = String(s ?? '');
    return JSON.stringify(str.length > max ? `${str.slice(0, max)}…` : str);
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One line per block: `blk_x hero "Your headline here" [disabled]`. */
function blockOutlineLine(b, indent = '    ') {
    const bits = [`${indent}${b.id} ${b.type}`];
    const c = isPlainObject(b.content) ? b.content : {};
    for (const key of ['title', 'heading', 'eyebrow', 'lead']) {
        if (typeof c[key] === 'string' && c[key]) { bits.push(q(c[key])); break; }
    }
    if (Array.isArray(c.titleParts) && c.titleParts.length && bits.length === 1) {
        bits.push(q(c.titleParts.map((p) => p && p.text).filter(Boolean).join(' ')));
    }
    if (b.enabled === false) bits.push('[disabled]');
    return bits.join(' ');
}

/** Compact link rendering for nav lines: `page pg_x#anchor` / `external …`. */
function navLinkSummary(link) {
    if (!isPlainObject(link)) return '?';
    switch (link.kind) {
        case 'page': return `page ${link.pageId}${link.anchor ? `#${link.anchor}` : ''}`;
        case 'external': return `external ${link.url}`;
        case 'anchor': return `anchor #${link.anchor}`;
        case 'app': return `app ${link.path}`;
        default: return '?';
    }
}

/**
 * One line per header-nav item WITH its id (the model addresses items by id
 * when replacing the menu): `[nav_ab12] "Pricing" → page pg_x (+2 children)`.
 */
function navItemLine(item, indent = '    ') {
    if (!isPlainObject(item)) return `${indent}(malformed nav item)`;
    const bits = [`${indent}[${item.id || '?'}] ${q(item.label)} → ${navLinkSummary(item.link)}`];
    const childCount = Array.isArray(item.children) ? item.children.length : 0;
    if (childCount) bits.push(`(+${childCount} child${childCount === 1 ? '' : 'ren'})`);
    const columns = isPlainObject(item.dropdown) && Array.isArray(item.dropdown.columns) ? item.dropdown.columns : null;
    if (columns) {
        const megaItems = columns.reduce((n, c) => n + (Array.isArray(c?.items) ? c.items.length : 0), 0);
        bits.push(`(mega: ${columns.length} col${columns.length === 1 ? '' : 's'}, ${megaItems} item${megaItems === 1 ? '' : 's'})`);
    }
    return bits.join(' ');
}

/**
 * The WHOLE design as compact JSON (~400 bytes against a 12KB page-JSON cap).
 * The old key=value line showed 6 of ~25 fields, which made design editing
 * impossible: the model could not see the components/layout groups it was
 * meant to patch, nor read back what its own cms_update_design call changed.
 */
function summariseDesignLine(design) {
    const d = isPlainObject(design) ? design : {};
    return `design (cms_update_design DEEP-MERGE patches this): ${JSON.stringify(d)}`;
}

/**
 * Compact ID-bearing rendering of the whole site: site line, design
 * one-liner, one section per page (id · slug · title · homepage? · block
 * outline), then the FULL JSON of the page in focus (context.activePageId,
 * else the homepage) capped at ~12KB.
 */
function renderDraftState(draftWrap, context = null) {
    const site = draftWrap?.site;
    if (!isPlainObject(site)) return '(no site loaded)';
    const pages = Array.isArray(site.pages) ? site.pages : [];
    const cache = draftWrap.pages instanceof Map ? draftWrap.pages : new Map();

    const lines = [];
    const locales = Array.isArray(draftWrap.locales) && draftWrap.locales.length ? draftWrap.locales.join(',') : '(none)';
    lines.push(`site ${q(site.name)} id=${site.id} defaultLocale=${draftWrap.defaultLocale || 'en'} locales=${locales} pages=${pages.length}`);
    lines.push(summariseDesignLine(site.design));

    // Header nav — one id-bearing line per item so the model can address
    // existing items when it replaces the menu via cms_update_header_nav.
    const nav = isPlainObject(site.header) && Array.isArray(site.header.nav) ? site.header.nav : [];
    lines.push(`header nav (${nav.length} item${nav.length === 1 ? '' : 's'} — cms_update_header_nav replaces the whole list):`);
    if (!nav.length) lines.push('    (empty — the header shows no menu links)');
    else for (const item of nav) lines.push(navItemLine(item));

    for (const entry of pages) {
        const flags = [];
        if (entry.isHomepage) flags.push('HOMEPAGE');
        if (entry.hideHeader) flags.push('hideHeader');
        if (entry.hideFooter) flags.push('hideFooter');
        lines.push(`page ${entry.id} slug=/${entry.slug} title=${q(entry.title)}${flags.length ? ` [${flags.join(' ')}]` : ''}`);
        const doc = cache.get(entry.id);
        const blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : null;
        if (!blocks) lines.push('    (blocks not loaded — call cms_get_page)');
        else if (!blocks.length) lines.push('    (no blocks yet)');
        else for (const b of blocks) lines.push(blockOutlineLine(b));
    }

    // Page in focus — full JSON when it fits.
    const focusId = (context && typeof context.activePageId === 'string' && pages.some((p) => p.id === context.activePageId))
        ? context.activePageId
        : (site.homepageId && pages.some((p) => p.id === site.homepageId) ? site.homepageId : (pages[0]?.id || null));
    if (focusId) {
        const doc = cache.get(focusId);
        if (doc) {
            const json = JSON.stringify(doc);
            if (json.length <= PAGE_JSON_CAP) {
                lines.push(`focus page ${focusId} — full JSON:`);
                lines.push(json);
            } else {
                lines.push(`focus page ${focusId} — too large to inline (${json.length} bytes); the outline above is complete. Call cms_get_page for the full JSON of any page you edit.`);
            }
        }
    }
    return lines.join('\n');
}

module.exports = {
    buildSystemPrompt,
    renderDraftState,
    renderCatalogText,
    PAGE_JSON_CAP,
};

// @typecheck
// Shared CMS-store internals: the config-key vocabulary, the stored-document
// version numbers, the small clone/merge helpers and the sanitizers every
// aggregate writes through. Leaf module — it requires no other cms/ file.

const crypto = require('crypto');
const {
    SITE_DEFAULTS,
    RESERVED_SLUGS,
    DESIGN_DEFAULTS,
    DESIGN_COMPONENT_ENUMS,
    DESIGN_LAYOUT_ENUMS,
} = require('../../i18n/defaults/cmsDefaults');
const { THEME_PRESET_IDS } = require('../../i18n/defaults/themePresets');

const KEY_DEFAULT_LOCALE  = 'cms_default_locale';
const KEY_PROJECTS_INDEX  = 'cms_projects_index';
const KEY_PROJECT_PFX     = 'cms_project_';                  // cms_project_{siteId}
const KEY_LOCALE_INFIX    = '_locale_';                      // ..._locale_{xx}
const KEY_PAGE_INFIX      = '_page_';                        // cms_project_{siteId}_page_{pageId}
const KEY_PUBLISHED_PFX   = 'cms_published_';                // cms_published_{siteId} — last-published snapshot
// Templates are GLOBAL — not scoped to a site. A template saved from one
// site can be applied when creating a new page in any site. Stored under
// a single top-level key as an array; the writes are full-list replace
// so there is no race window where a partial entry can land.
const KEY_TEMPLATES       = 'cms_templates';

// SITE_VERSION 3: header now supports a `ctas` array (multiple action
// buttons with style: primary/secondary/ghost/link) instead of a single
// ctaLink+ctaLabel pair, and a `logo` block (image src + text + style).
// The lazy migration in getProject seeds header.ctas once from the old
// ctaLabel/ctaLink (+ loginLabel as a ghost button) so existing live
// sites don't lose their header buttons.
//
// SITE_VERSION 2: pages no longer auto-merge into header.nav at render
// time; nav is fully owned by the user via Site chrome.
const SITE_VERSION = 3;
const PAGE_VERSION = 1;
const LOCALE_OVERRIDE_VERSION = 1;
const INDEX_VERSION = 1;
const PUBLISHED_VERSION = 1;

// ── Small helpers ────────────────────────────────────────────────────

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function deepMerge(base, override) {
    if (override === undefined || override === null) return base;
    if (Array.isArray(override)) return override;
    if (typeof override !== 'object') return override;
    if (!isPlainObject(base)) return { ...override };
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
        out[k] = deepMerge(base[k], v);
    }
    return out;
}

// Merge a sparse, text-only locale OVERRIDE onto BASE content. Unlike
// deepMerge (which replaces arrays wholesale), this is purpose-built for the
// per-locale translation layer:
//   - Structure is driven entirely by BASE: arrays merge by index (base
//     length wins, missing/extra override slots fall back to base), objects
//     recurse over base's key set only. So icons/links/styles/order are never
//     lost — they always come from the default-locale base.
//   - Text wins from the override only when it's a NON-EMPTY string, so a
//     cleared translation (empty string) reverts to the source text.
// Keep this in sync with the client mirror in
// agent-hub/src/components/admin/ProductWebsite/localeMerge.js.
function mergeLocaleContent(base, override) {
    if (override === undefined || override === null) return base;
    if (Array.isArray(base)) {
        if (!Array.isArray(override)) return base;
        return base.map((el, i) =>
            i < override.length ? mergeLocaleContent(el, override[i]) : el);
    }
    if (Array.isArray(override)) return base;
    if (isPlainObject(base)) {
        if (!isPlainObject(override)) return base;
        const out = { ...base };
        for (const k of Object.keys(base)) {
            if (Object.prototype.hasOwnProperty.call(override, k)) {
                out[k] = mergeLocaleContent(base[k], override[k]);
            }
        }
        return out;
    }
    if (typeof override === 'string' && override.trim() !== '') return override;
    return base;
}

function normalizeSlug(raw) {
    return String(raw || '')
        .toLowerCase()
        .trim()
        .replace(/^\/+/, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 64);
}

function isReservedSlug(slug) {
    return RESERVED_SLUGS.has(String(slug || '').toLowerCase());
}

function assertSiteId(siteId) {
    if (!siteId || typeof siteId !== 'string' || !/^pj_[a-f0-9]{4,}$/.test(siteId)) {
        throw new Error('Invalid siteId');
    }
}

// Sanitize a `design` blob coming from the admin panel. Strict-but-tolerant:
// unknown fields are dropped, malformed values fall back to DESIGN_DEFAULTS.
// Always returns a complete shape so the renderer can rely on every field.
// v2 fields (darkColors / typography / motion / grain / preset / fonts.mono)
// back-fill from DESIGN_DEFAULTS at read time, so stored v1 sites need no
// migration — their first save after this change persists the defaults.
function sanitizeDesign(input) {
    const d = isPlainObject(input) ? input : {};
    const c = isPlainObject(d.colors) ? d.colors : {};
    const f = isPlainObject(d.fonts)  ? d.fonts  : {};
    const dk = isPlainObject(d.darkColors) ? d.darkColors : {};
    const ty = isPlainObject(d.typography) ? d.typography : {};
    const str = (v, fb) => (typeof v === 'string' ? v : fb);
    // Shape-check, not an allow-list. An unknown-but-well-formed family stays
    // (cmsBuilder/validate.js warns `unknown_font` and it falls back to the
    // system stack), but a "family name" carrying markup has no legitimate
    // meaning and would otherwise reach the raw <style> block that
    // core/seo/fonts.js writes into the server-rendered head.
    const fontName = (v, fb) => {
        const name = typeof v === 'string' ? v.trim() : '';
        return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,48}$/.test(name) ? name : fb;
    };
    const numClamp = (v, lo, hi, fb) =>
        (typeof v === 'number' && v >= lo && v <= hi) ? Math.round(v) : fb;
    const oneOf = (v, set, fb) => (set.includes(v) ? v : fb);
    return {
        colors: {
            primary:       str(c.primary,       DESIGN_DEFAULTS.colors.primary),
            secondary:     str(c.secondary,     DESIGN_DEFAULTS.colors.secondary),
            accent:        str(c.accent,        DESIGN_DEFAULTS.colors.accent),
            background:    str(c.background,    DESIGN_DEFAULTS.colors.background),
            surface:       str(c.surface,       DESIGN_DEFAULTS.colors.surface),
            textPrimary:   str(c.textPrimary,   DESIGN_DEFAULTS.colors.textPrimary),
            textSecondary: str(c.textSecondary, DESIGN_DEFAULTS.colors.textSecondary),
        },
        darkColors: {
            background:    str(dk.background,    DESIGN_DEFAULTS.darkColors.background),
            surface:       str(dk.surface,       DESIGN_DEFAULTS.darkColors.surface),
            textPrimary:   str(dk.textPrimary,   DESIGN_DEFAULTS.darkColors.textPrimary),
            textSecondary: str(dk.textSecondary, DESIGN_DEFAULTS.darkColors.textSecondary),
            primary:       str(dk.primary,       ''),
            accent:        str(dk.accent,        ''),
        },
        fonts: {
            heading: fontName(f.heading, DESIGN_DEFAULTS.fonts.heading),
            body:    fontName(f.body,    DESIGN_DEFAULTS.fonts.body),
            mono:    fontName(f.mono,    DESIGN_DEFAULTS.fonts.mono),
        },
        logo:     str(d.logo,    ''),
        favicon:  str(d.favicon, ''),
        radius:   numClamp(d.radius, 0, 24, DESIGN_DEFAULTS.radius),
        theme:    d.theme === 'dark' ? 'dark' : 'light',
        gradient: d.gradient === true,
        // Derived from the preset module rather than a hardcoded list — a
        // literal here silently degraded every new theme to 'custom'.
        preset:   oneOf(d.preset, THEME_PRESET_IDS, 'custom'),
        typography: {
            displaySize:   oneOf(ty.displaySize,   ['md', 'lg', 'xl'], DESIGN_DEFAULTS.typography.displaySize),
            headingWeight: oneOf(ty.headingWeight, [500, 600, 700],    DESIGN_DEFAULTS.typography.headingWeight),
            bodySize:      oneOf(ty.bodySize,      [16, 17, 18],       DESIGN_DEFAULTS.typography.bodySize),
        },
        motion: oneOf(d.motion, ['none', 'subtle', 'full'], DESIGN_DEFAULTS.motion),
        grain:  d.grain === true,
        components: sanitizeEnumGroup(d.components, DESIGN_COMPONENT_ENUMS, DESIGN_DEFAULTS.components),
        layout:     sanitizeEnumGroup(d.layout,     DESIGN_LAYOUT_ENUMS,    DESIGN_DEFAULTS.layout),
    };
}

// Build an enum-only sub-object key-by-key from an allow-list, so unknown
// keys are impossible and every value is a legal enum member. An absent or
// invalid value falls back to the default, which is always the IDENTITY
// value (renders exactly as before the theme system existed).
function sanitizeEnumGroup(input, enums, defaults) {
    const src = isPlainObject(input) ? input : {};
    const out = {};
    for (const [key, allowed] of Object.entries(enums)) {
        out[key] = allowed.includes(src[key]) ? src[key] : defaults[key];
    }
    return out;
}

// Sanitize the site-level `analytics` blob. One field today:
// gaMeasurementId — a Google Analytics 4 measurement id ("G-XXXXXXXXXX").
// Lowercase input is normalized to uppercase; anything that doesn't look
// like a GA4 id after that is blanked so the public site never injects
// gtag with a junk value. Always returns a complete shape.
function sanitizeAnalytics(a) {
    if (!isPlainObject(a)) return clone(SITE_DEFAULTS.analytics);
    const id = String(a.gaMeasurementId || '').trim().toUpperCase();
    return {
        gaMeasurementId: /^G-[A-Z0-9]{4,20}$/.test(id) ? id : '',
    };
}

// ── Key builders (every key is project-scoped except the index) ──────

function projectKey(siteId)                        { return `${KEY_PROJECT_PFX}${siteId}`; }
function projectLocaleKey(siteId, locale)          { return `${KEY_PROJECT_PFX}${siteId}${KEY_LOCALE_INFIX}${locale}`; }
function pageKey(siteId, pageId)                   { return `${KEY_PROJECT_PFX}${siteId}${KEY_PAGE_INFIX}${pageId}`; }
function pageLocaleKey(siteId, pageId, locale)     { return `${KEY_PROJECT_PFX}${siteId}${KEY_PAGE_INFIX}${pageId}${KEY_LOCALE_INFIX}${locale}`; }
function publishedKey(siteId)                      { return `${KEY_PUBLISHED_PFX}${siteId}`; }

module.exports = {
    KEY_DEFAULT_LOCALE, KEY_PROJECTS_INDEX, KEY_PROJECT_PFX, KEY_LOCALE_INFIX,
    KEY_PAGE_INFIX, KEY_PUBLISHED_PFX, KEY_TEMPLATES,
    SITE_VERSION, PAGE_VERSION, LOCALE_OVERRIDE_VERSION, INDEX_VERSION, PUBLISHED_VERSION,
    newId, isPlainObject, clone, deepMerge, mergeLocaleContent,
    normalizeSlug, isReservedSlug, assertSiteId,
    sanitizeDesign, sanitizeAnalytics,
    projectKey, projectLocaleKey, pageKey, pageLocaleKey, publishedKey,
};

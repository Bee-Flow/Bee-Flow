// @typecheck
const cmsStore = require('../stores/cmsStore');
const { DESIGN_COMPONENT_ENUMS, DESIGN_LAYOUT_ENUMS, DESIGN_THEMES, DESIGN_MOTIONS, DARK_BANDS, DISPLAY_SIZES, HEADING_WEIGHTS, DISPLAY_TRACKINGS, BODY_SIZES, COLOR_KEYS, BLANKABLE_COLORS, DARK_COLOR_KEYS, DESIGN_FONTS } = require('../i18n/defaults/cmsDefaults');
const { THEME_PRESETS, THEME_PRESET_IDS } = require('../i18n/defaults/themePresets');
const { DESIGN_HINT } = require('./schemas');
const { isPlainObject, clone, refreshSite } = require('./builderToolsShared');

// Design caps (cms_update_design). Same deal as the nav: the tool owns ALL
// design validation because cmsStore.sanitizeDesign COERCES rather than
// rejects (a bad hex is stored verbatim, an unknown enum silently falls back
// to the identity value) — echoing the request back would report success for
// an edit that evaporated.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const FONT_ROLES = ['heading', 'body', 'mono'];

const TYPOGRAPHY_ENUMS = {
    displaySize: DISPLAY_SIZES,
    headingWeight: HEADING_WEIGHTS,
    displayTracking: DISPLAY_TRACKINGS,
    bodySize: BODY_SIZES,
};

// darkColors.primary/accent take '' = "reuse the light value" (see
// DESIGN_DEFAULTS.darkColors) — every other colour must be a real hex.
const BLANKABLE_DARK_COLORS = ['primary', 'accent'];

/**
 * One-line human summary of a DesignDoc — feeds cms_list_site's
 * `designSummary` and cms_update_design's `summary`. Covers every themable
 * dimension (the old 4-field version made design edits invisible to the
 * model, which could then not tell what its own patch had done).
 */
function summariseDesign(design) {
    const d = isPlainObject(design) ? design : {};
    const colors = isPlainObject(d.colors) ? d.colors : {};
    const fonts = isPlainObject(d.fonts) ? d.fonts : {};
    const ty = isPlainObject(d.typography) ? d.typography : {};
    const cp = isPlainObject(d.components) ? d.components : {};
    const ly = isPlainObject(d.layout) ? d.layout : {};
    return [
        `preset ${d.preset || 'custom'}`,
        `theme ${d.theme || 'light'}`,
        `primary ${colors.primary || '?'}`,
        `accent ${colors.accent || '?'}`,
        `background ${colors.background || '?'}`,
        `fonts ${fonts.heading || '?'}/${fonts.body || '?'}/${fonts.mono || '?'}`,
        `radius ${d.radius ?? '?'}`,
        `type ${ty.displaySize || '?'}/${ty.headingWeight ?? '?'}/${ty.bodySize ?? '?'}/${ty.displayTracking || 'default'}`,
        `motion ${d.motion || '?'}`,
        `grain ${d.grain ? 'on' : 'off'}`,
        `gradient ${d.gradient ? 'on' : 'off'}`,
        `buttons ${cp.buttonShape || '?'}/${cp.buttonSize || '?'}/${cp.buttonTextColor || '?'}`,
        `nav ${cp.navStyle || '?'}/${cp.navHeight || '?'}`,
        `logo ${cp.logoSize || '?'}`,
        `cards ${cp.cardStyle || '?'}/${cp.cardPadding || '?'}`,
        `shadow ${cp.shadow || '?'}`,
        `container ${ly.containerWidth || '?'}`,
        `rhythm ${ly.sectionRhythm || '?'}`,
    ].join(' · ');
}

/**
 * Build the design patch key-by-key from allow-lists — unknown keys are
 * impossible by construction, and everything sanitizeDesign would silently
 * swallow is rejected with DESIGN_HINT as the teaching signal.
 * Returns { patch } or { error, _fixHint }.
 */
function sanitizeDesignPatch(args) {
    const bad = (message) => ({ error: message, _fixHint: DESIGN_HINT });
    if (!isPlainObject(args)) return bad('cms_update_design takes an object of patch fields.');
    const patch = {};

    if (args.preset !== undefined) {
        if (!THEME_PRESET_IDS.includes(args.preset)) {
            return bad(`preset ${JSON.stringify(args.preset ?? null)} is not a built-in theme. Known presets: ${THEME_PRESET_IDS.join(', ')}.`);
        }
        patch.preset = args.preset;
    }

    /** Colour group: every value a literal #rrggbb (some keys also allow ''). */
    const colourGroup = (raw, allowedKeys, path, blankable) => {
        if (!isPlainObject(raw)) return bad(`${path} must be an object of colour keys.`);
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
            if (!allowedKeys.includes(key)) {
                return bad(`${path}.${key} is not a colour of this site. Valid keys: ${allowedKeys.join(', ')}.`);
            }
            const blankOk = value === '' && blankable.includes(key);
            if (!blankOk && (typeof value !== 'string' || !HEX_RE.test(value))) {
                return bad(`${path}.${key} ${JSON.stringify(value ?? null)} is not a "#rrggbb" hex colour.`);
            }
            out[key] = value;
        }
        return { out };
    };

    if (args.colorsPatch !== undefined) {
        const r = colourGroup(args.colorsPatch, COLOR_KEYS, 'colorsPatch', BLANKABLE_COLORS);
        if (r.error) return r;
        if (Object.keys(r.out).length) patch.colors = r.out;
    }
    if (args.darkColorsPatch !== undefined) {
        const r = colourGroup(args.darkColorsPatch, DARK_COLOR_KEYS, 'darkColorsPatch', BLANKABLE_DARK_COLORS);
        if (r.error) return r;
        if (Object.keys(r.out).length) patch.darkColors = r.out;
    }

    if (args.fontsPatch !== undefined) {
        if (!isPlainObject(args.fontsPatch)) return bad('fontsPatch must be an object { heading?, body?, mono? }.');
        const fonts = {};
        for (const [role, value] of Object.entries(args.fontsPatch)) {
            if (!FONT_ROLES.includes(role)) {
                return bad(`fontsPatch.${role} is not a font role. Valid roles: ${FONT_ROLES.join(', ')}.`);
            }
            if (typeof value !== 'string' || !DESIGN_FONTS.includes(value)) {
                return bad(`fontsPatch.${role} ${JSON.stringify(value ?? null)} is not an available font — the site can only load the ${DESIGN_FONTS.length} faces in the library.`);
            }
            fonts[role] = value;
        }
        if (Object.keys(fonts).length) patch.fonts = fonts;
    }

    /** Enum group (typography / components / layout) — closed key + value set. */
    const enumGroup = (raw, enums, path) => {
        if (!isPlainObject(raw)) return bad(`${path} must be an object.`);
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
            const allowed = enums[key];
            if (!allowed) {
                return bad(`${path}.${key} is not a field of ${path}. Valid fields: ${Object.keys(enums).join(', ')}.`);
            }
            // MCP clients often send numbers as strings: a numeric enum accepts "700".
            const numeric = allowed.every((a) => typeof a === 'number');
            const v = numeric && typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
            if (!allowed.includes(v)) {
                const list = allowed.map((a) => JSON.stringify(a)).join(', ');
                return bad(`${path}.${key} ${JSON.stringify(value ?? null)} is not a legal value. Valid${numeric ? ' (a number)' : ''}: ${list}.`);
            }
            out[key] = v;
        }
        return { out };
    };

    /** @type {Array<[string, Record<string, Array<string|number>>, string]>} */
    const enumGroups = [
        ['typographyPatch', TYPOGRAPHY_ENUMS, 'typography'],
        ['componentsPatch', DESIGN_COMPONENT_ENUMS, 'components'],
        ['layoutPatch', DESIGN_LAYOUT_ENUMS, 'layout'],
    ];
    for (const [arg, enums, field] of enumGroups) {
        if (args[arg] === undefined) continue;
        const r = enumGroup(args[arg], enums, arg);
        if (r.error) return r;
        if (Object.keys(r.out).length) patch[field] = r.out;
    }

    if (args.radius !== undefined) {
        if (typeof args.radius !== 'number' || !Number.isFinite(args.radius) || args.radius < 0 || args.radius > 24) {
            return bad(`radius ${JSON.stringify(args.radius ?? null)} is out of range — use a whole number from 0 to 24.`);
        }
        patch.radius = Math.round(args.radius);
    }
    if (args.theme !== undefined) {
        if (!DESIGN_THEMES.includes(args.theme)) {
            return bad(`theme ${JSON.stringify(args.theme ?? null)} is invalid. Valid: ${DESIGN_THEMES.join(', ')}.`);
        }
        patch.theme = args.theme;
    }
    if (args.motion !== undefined) {
        if (!DESIGN_MOTIONS.includes(args.motion)) {
            return bad(`motion ${JSON.stringify(args.motion ?? null)} is invalid. Valid: ${DESIGN_MOTIONS.join(', ')}.`);
        }
        patch.motion = args.motion;
    }
    if (args.darkBand !== undefined) {
        if (!DARK_BANDS.includes(args.darkBand)) {
            return bad(`darkBand ${JSON.stringify(args.darkBand ?? null)} is invalid. Valid: ${DARK_BANDS.join(', ')}.`);
        }
        patch.darkBand = args.darkBand;
    }
    for (const flag of ['grain', 'gradient']) {
        if (args[flag] === undefined) continue;
        if (typeof args[flag] !== 'boolean') return bad(`${flag} must be true or false.`);
        patch[flag] = args[flag];
    }

    if (!Object.keys(patch).length) {
        return bad('Nothing to change — pass at least one of: preset, colorsPatch, darkColorsPatch, fontsPatch, typographyPatch, componentsPatch, layoutPatch, radius, theme, motion, darkBand, grain, gradient.');
    }
    return { patch };
}

async function applyUpdateDesign(draftWrap, args) {
    const sanitized = sanitizeDesignPatch(args);
    if (sanitized.error) return sanitized;
    // Applied to the SiteDoc as stored NOW, under the store's lock: only
    // `design` changes, so pages and chrome saved meanwhile by another admin stay.
    try {
        await cmsStore.mutateProject(draftWrap.siteId, (site) => {
            let design = isPlainObject(site.design) ? clone(site.design) : {};
            const { preset, ...groups } = sanitized.patch;

            // A preset MATERIALIZES its concrete values first (the renderer never
            // looks a preset up), mirroring applyPreset() on the client: nested
            // groups are re-cloned wholesale so nothing leaks from the old theme,
            // and the uploaded logo/favicon are kept.
            if (preset) {
                const entry = THEME_PRESETS.find((p) => p.id === preset);
                design = { ...design, ...clone(entry.design), logo: design.logo || '', favicon: design.favicon || '', preset };
            }
            // Then the explicit patches layer on top, DEEP-MERGED per group so
            // { colorsPatch:{primary} } keeps the other six colours.
            for (const [key, value] of Object.entries(groups)) {
                design[key] = isPlainObject(value) && isPlainObject(design[key])
                    ? { ...design[key], ...value }
                    : value;
            }
            site.design = design;
        }, { bumpRev: true });
    } catch (e) {
        return { error: e.message };
    }
    await refreshSite(draftWrap);
    // CRITICAL: report what was PERSISTED, never the request. sanitizeDesign
    // coerces silently, so echoing the patch back would tell the model an
    // edit succeeded that the store had already dropped.
    const saved = isPlainObject(draftWrap.site?.design) ? draftWrap.site.design : {};
    return { design: clone(saved), summary: summariseDesign(saved) };
}

module.exports = { summariseDesign, sanitizeDesignPatch, applyUpdateDesign };

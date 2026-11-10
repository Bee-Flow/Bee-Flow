// @typecheck
/**
 * App Design v2 — the OPTIONAL `definition.design` and `definition.nav`
 * vocabularies that turn a Studio app from "themed" into "designed".
 *
 * WHY THIS IS NOT PART OF `theme`: THEME_SPEC lives in server/core/themeSpec.js
 * because the automation form trigger shares it and may not depend on appStudio
 * — and fonts, surfaces and navigation make no sense on a hosted form page.
 * Also, canonicalizeAppDefinition always emits a COMPLETE theme, so growing
 * THEME_SPEC would change the canonical bytes of every stored definition.
 * `design` and `nav` are instead EMIT-WHEN-PRESENT (the screen.kind /
 * refreshInterval pattern): an absent key stays absent, so every pre-existing
 * definition canonicalizes byte-identically and the templates' "no structural
 * repairs" contract holds untouched.
 *
 * IDENTITY DISCIPLINE (the applyDesignToRoot / marketing tokens.css pattern):
 * every enum's default is "today's rendering". The runtime emits no class and
 * no CSS variable for a default value, and every CSS consumer is written
 * `var(--token, <today's literal>)` — so absent field ≡ explicit default ≡
 * today's pixels. A definition WITH a design that happens to be all-identity
 * is kept as given (updateDesign controls writes; no normalize-to-absent).
 *
 * The frontend mirror is
 * agent-hub/src/components/admin/Studio/AppStudio/runtime/appDesign.js —
 * pinned in lockstep by runtime/catalogLockstep.test.js.
 */

'use strict';

const crypto = require('crypto');
const { valueTypeOf, isAssetRef } = require('./componentSpecs/valueTypes');
const { LIMITS } = require('./componentSpecs/limits');
const { cleanAppCss, appCssRepairNote } = require('./appCss.mts');

// Font PAIRING ids, not raw family names: the closed vocabulary keeps the
// builder/editor honest and every family on the CMS DESIGN_FONTS allowlist.
// Self-hosted (Fontshare originals under agent-hub/public/fonts/) first —
// they load without a Google round-trip and carry the "modern SaaS" look.
const FONT_FAMILIES = Object.freeze({
    system: null, // identity — the host UI stack, exactly today's rendering
    inter: 'Inter',
    satoshi: 'Satoshi',
    'general-sans': 'General Sans',
    cabinet: 'Cabinet Grotesk',
    geist: 'Geist',
    plex: 'IBM Plex Sans',
    poppins: 'Poppins',
});

/**
 * One design key. `optional: true` marks a key added after the base seven: it is written
 * only when the design carries a valid value for it, never as a default, so a design stored
 * before the key existed keeps its bytes. A base key is always written (its default when
 * absent). A key added later is optional and may use a value type of
 * componentSpecs/valueTypes.js as its `type`.
 * @typedef {{ type: 'enum', values: string[], default: string, optional?: boolean } | { type: 'url', default: string | null, maxLen: number, optional?: boolean }} DesignSpecEntry
 */

const DESIGN_SPEC = Object.freeze(/** @satisfies {Record<string, DesignSpecEntry>} */ ({
    // Provenance only: applying a preset MATERIALIZES its values into theme /
    // design / nav (themePresets.js precedent) — this field just remembers
    // which gallery card the owner started from, so the editor can show it as
    // selected and "custom" the moment they diverge.
    preset: { type: 'enum', values: ['custom', 'classic', 'cloud', 'atlas', 'midnight', 'field', 'paper', 'mono'], default: 'custom' },
    font: { type: 'enum', values: Object.keys(FONT_FAMILIES), default: 'system' },
    // ONE surface knob (presets-over-knobs), mapping to semantic elevation
    // tokens --app-shadow-1/2/3 that the high-contrast host theme re-declares
    // as RINGS — which is what resolves the long-standing objection to a raw
    // shadow knob (its meaning flips per host theme).
    surface: { type: 'enum', values: ['hairline', 'flat', 'soft', 'elevated'], default: 'hairline' },
    // 'subtle' is identity: the universal-polish baseline motion. 'none'
    // stamps .app-motion--none; prefers-reduced-motion always wins in CSS.
    // 'full' is accepted and stored but renders exactly like 'subtle'.
    motion: { type: 'enum', values: ['none', 'subtle', 'full'], default: 'subtle' },
    chartPalette: { type: 'enum', values: ['classic', 'brand'], default: 'classic' },
    // The coloured 3px edge that marks a callout's tone, a toned table row, a
    // message's side. 'bar' is what every app has today and stays the default.
    // 'none' drops the stripes and leaves the tint to carry the meaning: a wall
    // of little coloured edges is the single loudest tell of a generated
    // interface, and an app that has earned its own typography and spacing
    // should not have to keep them.
    accentEdge: { type: 'enum', values: ['bar', 'none'], default: 'bar' },
    logoUrl: { type: 'url', default: null, maxLen: 500 },
    // The app's own stylesheet (appCss.mts says what is kept). Stored sanitised; the page
    // sanitises it again and mounts it inside @scope ([data-app-css-root]).
    customCss: {
        type: 'css', optional: true, since: 3, maxLen: LIMITS.MAX_CUSTOM_CSS_LEN,
        sanitize: cleanAppCss,
        repairNote: appCssRepairNote,
        description: 'A stylesheet of the app, for what theme and style knobs cannot do. '
            + 'Plain CSS text, applied to the content of every screen of this app (not to its navigation bar) and to nothing outside it. Reach for the theme, the design keys and the style knobs first: they follow dark mode and high contrast by themselves, a stylesheet does not. '
            + 'Selectors that are a contract: [data-app-screen="<screen id>"] (one screen), [data-section-id="<section id>"] (one section), [data-node-id="<node id>"] (the cell of one component), [data-app-type="<type>"] (every component of a type, e.g. [data-app-type="button"]), .u-<name> (every component whose cssClass is <name>), and inside a component the part classes .bfa-<type>__<part> where the type lists parts. Any other class name of the product can change without notice. '
            + 'Colours: prefer the variables var(--app-primary), var(--app-accent), var(--app-canvas), var(--text-primary), var(--bg-card) and var(--border-default) over fixed values. Dark mode: the app root carries data-app-dark="true" or "false", so write [data-app-dark="true"] .u-hero { … } for the dark variant. Under the high-contrast theme the stylesheet is not applied at all, so nothing may depend on it to be readable. '
            + 'Allowed at-rules: @media, @supports, @container. Comments are not kept. Removed when saved, and named in the repair hints: every other at-rule (@import, @font-face, @keyframes, …), position: fixed, and a url() that is not data:image/… or asset:<id> (an uploaded file of this app). Write it with app_set_theme { customCss: "<the whole stylesheet>" } (the text replaces what was there), and pass null to remove it.',
    },
}));

// Four ways to move around an app, so the shape can follow the work:
//   tabs    — identity. A top row of screens; groups flatten into it.
//   sidebar — grouped, collapsible, labelled. Right from ~6 screens.
//   mega    — a top bar whose GROUPS open a panel of screens shown as
//             icon + name + description. Reads like a product's own navigation
//             rather than a form's. Falls back to `tabs` rendering when the
//             definition declares no groups, so choosing it is never a dead end.
//   rail    — an icon-only sidebar with tooltips; groups become separators.
//             For dense tool-shaped apps where the screen is the workspace.
const NAV_STYLES = Object.freeze(['tabs', 'sidebar', 'mega', 'rail']);
const NAV_DEFAULT_STYLE = 'tabs';
const MAX_NAV_GROUPS = 10;
const MAX_NAV_GROUP_LABEL = 40;
const NAV_GROUP_ID_RE = /^nvg_[a-z0-9]{4,12}$/;

/** @param {unknown} v */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @typedef {{ type: string, [k: string]: any }} DesignKeySpec  A design key as canonDesign reads it.
 * @typedef {(code: string, path: string, message: string) => void} DesignPush
 */

/**
 * @param {string} key
 * @param {DesignKeySpec} spec
 * @param {unknown} v
 * @param {DesignPush} push
 */
function canonDesignEnum(key, spec, v, push) {
    if (spec.values.includes(v)) return v;
    if (v !== undefined) {
        push('design.value_invalid', `design.${key}`, `design.${key} ${JSON.stringify(v)} is invalid — ${spec.optional ? 'dropped' : `defaulted to ${JSON.stringify(spec.default)}`}. Legal: ${spec.values.join(', ')}.`);
    }
    return spec.optional ? undefined : spec.default;
}

/**
 * @param {string} key
 * @param {DesignKeySpec} spec
 * @param {unknown} v
 * @param {DesignPush} push
 */
function canonDesignUrl(key, spec, v, push) {
    if (v === null || v === undefined) return spec.default;
    if (typeof v === 'string' && v.startsWith('https://') && v.length <= spec.maxLen) return v;
    // An uploaded file of the app (`asset:<id>`, appAssets.mts), e.g. the logo.
    if (isAssetRef(v)) return v;
    push('design.value_invalid', `design.${key}`, `design.${key} must be an https:// URL of at most ${spec.maxLen} characters, or asset:<id> of an uploaded file — ${spec.optional ? 'dropped' : 'reset to null'}.`);
    return spec.optional ? undefined : spec.default;
}

/**
 * A value type added later (componentSpecs/valueTypes.js). It has no default to write, so
 * it only exists as an optional key.
 * @param {string} key
 * @param {DesignKeySpec} spec
 * @param {unknown} v
 * @param {DesignPush} push
 */
function canonDesignTyped(key, spec, v, push) {
    const valueType = valueTypeOf(spec);
    if (!valueType || !spec.optional) return undefined;
    // Empty text is "not set", like null: the key leaves no trace and nothing is reported.
    if (typeof v === 'string' && !v.trim()) return undefined;
    const cleaned = valueType.clean(v, spec);
    // A key whose value is cleaned rather than refused says what it took out.
    const note = cleaned !== v && typeof spec.repairNote === 'function' ? spec.repairNote(v) : null;
    if (cleaned === undefined) push('design.value_invalid', `design.${key}`, `design.${key} is not an acceptable value — dropped. ${note || valueType.hint(spec)}`);
    else if (note) push('design.value_cleaned', `design.${key}`, note);
    return cleaned;
}

/**
 * The value to write for one design key, or undefined to leave the key out. Only an
 * `optional` key is ever left out: a base key falls back to its default.
 * @param {string} key
 * @param {DesignKeySpec} spec
 * @param {unknown} v
 * @param {DesignPush} push
 */
function canonDesignValue(key, spec, v, push) {
    // An optional key that is absent (or null: "not set") leaves no trace.
    if (spec.optional && (v === undefined || v === null)) return undefined;
    if (spec.type === 'enum') return canonDesignEnum(key, spec, v, push);
    if (spec.type === 'url') return canonDesignUrl(key, spec, v, push);
    return canonDesignTyped(key, spec, v, push);
}

/**
 * Canonicalize a PRESENT `definition.design` object into the complete,
 * deterministic form (all spec keys, invalid values defaulted with a repair).
 * The caller only invokes this when input.design is an object — absence stays
 * absence. A key marked `optional` is the exception to "all spec keys": it is
 * written only when present and valid.
 * @param {unknown} raw
 * @param {(code: string, path: string, message: string) => void} push
 * @param {Record<string, unknown>} [designSpec] The key table; DESIGN_SPEC unless a test passes its own.
 */
function canonDesign(raw, push, designSpec = DESIGN_SPEC) {
    /** @type {Record<string, unknown>} */
    const out = {};
    const src = isObject(raw) ? raw : {};
    for (const [key, spec] of Object.entries(/** @type {Record<string, DesignKeySpec>} */ (designSpec))) {
        const value = canonDesignValue(key, spec, src[key], push);
        if (value !== undefined) out[key] = value;
    }
    const unknown = Object.keys(src).filter((k) => !(k in designSpec));
    if (unknown.length) {
        push('design.unknown_key', 'design', `Dropped unknown design keys: ${unknown.join(', ')}. Legal keys: ${Object.keys(designSpec).join(', ')}.`);
    }
    return out;
}

/**
 * Canonicalize a PRESENT `definition.nav` object's SHAPE: style enum, group
 * structure, group ids and labels. Group `screens` entries are kept as-given
 * strings here — screen ids are assigned in canonicalize's pass 1 and
 * rewritten in pass 2, so ref resolution happens in resolveNavScreens (called
 * from rewriteAndResolve, where the rename map and the final screen-id set
 * exist).
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function canonNavShape(raw, push) {
    const src = isObject(raw) ? raw : {};
    const out = {};

    if (NAV_STYLES.includes(src.style)) {
        out.style = src.style;
    } else {
        out.style = NAV_DEFAULT_STYLE;
        if (src.style !== undefined) {
            push('nav.value_invalid', 'nav.style', `nav.style ${JSON.stringify(src.style)} is invalid — defaulted to "${NAV_DEFAULT_STYLE}". Legal: ${NAV_STYLES.join(', ')}.`);
        }
    }

    if (src.groups !== undefined) {
        if (!Array.isArray(src.groups)) {
            push('nav.groups_invalid', 'nav.groups', 'nav.groups must be an array of { id, label, icon, screens } — dropped.');
        } else {
            const seen = new Set();
            const groups = [];
            src.groups.forEach((g, i) => {
                if (groups.length >= MAX_NAV_GROUPS) {
                    if (groups.length === MAX_NAV_GROUPS) {
                        push('nav.too_many_groups', `nav.groups[${i}]`, `At most ${MAX_NAV_GROUPS} nav groups — the rest were dropped.`);
                    }
                    return;
                }
                if (!isObject(g)) {
                    push('nav.group_invalid', `nav.groups[${i}]`, 'Nav group is not an object — dropped.');
                    return;
                }
                const label = (typeof g.label === 'string' && g.label.trim())
                    ? g.label.trim().slice(0, MAX_NAV_GROUP_LABEL)
                    : null;
                if (!label) {
                    push('nav.group_invalid', `nav.groups[${i}]`, 'Nav group needs a non-empty label — dropped.');
                    return;
                }
                let id = (typeof g.id === 'string' && NAV_GROUP_ID_RE.test(g.id) && !seen.has(g.id)) ? g.id : null;
                if (!id) {
                    do {
                        id = 'nvg_' + crypto.randomBytes(3).toString('hex');
                    } while (seen.has(id));
                    if (g.id !== undefined) {
                        push('nav.group_id', `nav.groups[${i}].id`, `Nav group id reassigned to "${id}" (must match nvg_<4-12 alphanumerics> and be unique).`);
                    }
                }
                seen.add(id);
                const icon = (typeof g.icon === 'string' && g.icon) ? g.icon : null;
                const screens = Array.isArray(g.screens)
                    ? g.screens.filter((s) => typeof s === 'string' && s)
                    : [];
                groups.push({ id, label, icon, screens });
            });
            if (groups.length) out.groups = groups;
        }
    }
    return out;
}

/**
 * Pass-2 resolution for nav group screen refs: rewrite renamed screen ids,
 * drop refs to screens that do not exist, drop duplicates ACROSS groups (a
 * screen renders in one nav place), and drop groups that end up empty.
 * Mutates and returns `nav`; returns undefined when nothing survives but the
 * default style (so the definition stays minimal — style-only navs are kept
 * only when the style is non-default).
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function resolveNavScreens(nav, renameMap, validScreenIds, push) {
    if (!isObject(nav)) return undefined;
    if (Array.isArray(nav.groups)) {
        const claimed = new Set();
        const groups = [];
        nav.groups.forEach((g, i) => {
            const screens = [];
            for (const ref of g.screens) {
                const resolved = renameMap.get(ref) || ref;
                if (!validScreenIds.has(resolved)) {
                    push('nav.screen_unknown', `nav.groups[${i}].screens`, `Nav group "${g.label}" referenced unknown screen ${JSON.stringify(ref)} — dropped.`);
                    continue;
                }
                if (claimed.has(resolved)) {
                    push('nav.screen_duplicate', `nav.groups[${i}].screens`, `Screen ${JSON.stringify(resolved)} appears in more than one nav group — kept in the first.`);
                    continue;
                }
                claimed.add(resolved);
                screens.push(resolved);
            }
            if (screens.length) {
                groups.push({ ...g, screens });
            } else {
                push('nav.group_empty', `nav.groups[${i}]`, `Nav group "${g.label}" has no (remaining) screens — dropped.`);
            }
        });
        if (groups.length) nav.groups = groups;
        else delete nav.groups;
    }
    if (!nav.groups && nav.style === NAV_DEFAULT_STYLE) return undefined;
    return nav;
}

module.exports = {
    DESIGN_SPEC,
    FONT_FAMILIES,
    NAV_STYLES,
    NAV_DEFAULT_STYLE,
    MAX_NAV_GROUPS,
    MAX_NAV_GROUP_LABEL,
    canonDesign,
    canonNavShape,
    resolveNavScreens,
};

/** @typedef {{ id: string, label: string, icon: string | null, screens: string[] }} NavGroup */

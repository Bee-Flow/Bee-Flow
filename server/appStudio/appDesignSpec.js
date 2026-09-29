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

const DESIGN_SPEC = Object.freeze({
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
});

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

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Canonicalize a PRESENT `definition.design` object into the complete,
 * deterministic form (all spec keys, invalid values defaulted with a repair).
 * The caller only invokes this when input.design is an object — absence stays
 * absence.
 */
function canonDesign(raw, push) {
    const out = {};
    const src = isObject(raw) ? raw : {};
    for (const [key, spec] of Object.entries(DESIGN_SPEC)) {
        const v = src[key];
        if (spec.type === 'enum') {
            if (spec.values.includes(v)) { out[key] = v; continue; }
            out[key] = spec.default;
            if (v !== undefined) {
                push('design.value_invalid', `design.${key}`, `design.${key} ${JSON.stringify(v)} is invalid — defaulted to ${JSON.stringify(spec.default)}. Legal: ${spec.values.join(', ')}.`);
            }
        } else if (spec.type === 'url') {
            if (v === null || v === undefined) { out[key] = spec.default; continue; }
            if (typeof v === 'string' && /^https:\/\//.test(v) && v.length <= spec.maxLen) {
                out[key] = v;
            } else {
                out[key] = spec.default;
                push('design.value_invalid', `design.${key}`, `design.${key} must be an https:// URL of at most ${spec.maxLen} characters — reset to null.`);
            }
        }
    }
    const unknown = Object.keys(src).filter((k) => !(k in DESIGN_SPEC));
    if (unknown.length) {
        push('design.unknown_key', 'design', `Dropped unknown design keys: ${unknown.join(', ')}. Legal keys: ${Object.keys(DESIGN_SPEC).join(', ')}.`);
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

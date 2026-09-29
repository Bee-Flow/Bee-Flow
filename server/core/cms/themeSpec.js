/**
 * The shared "no-code theming" vocabulary: five knobs that restyle a whole
 * surface without anyone writing CSS — plus two OPTIONAL colours.
 *
 * `accent` and `canvas` are emit-when-present. A theme that never set them
 * canonicalizes byte-identically to before they existed, and every consumer
 * falls back on its own (accent → the primary family, canvas → the platform
 * ground), so the five classic knobs keep their exact meaning. They exist for
 * brands that are more than one colour: the page a customer fills in painted
 * in the customer's yellow, its buttons in the customer's green, while the
 * headings, links and progress stay on the primary.
 *
 * It lived in appStudio/componentSpecs.js, which is fine while App Studio is
 * the only consumer — but the automation form trigger needs the same knobs and
 * the dependency direction is fixed: automation may not require appStudio (see
 * automation/appTriggerContract.js's note on MAX_STRING_VALUE). So the spec
 * moved here, to a neutral home both may depend on. componentSpecs.js re-
 * exports it, so every existing `require('./componentSpecs').THEME_SPEC` and
 * the client spec bundle are unchanged.
 *
 * The frontend mirror is
 * agent-hub/src/components/admin/Studio/AppStudio/runtime/themeVars.js — keep
 * the two in lockstep.
 */

'use strict';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Curated presets (no purple/violet/indigo hues — house rule for our chrome
// AND the default palette; a user may still type a custom hex).
const THEME_PRIMARY_PRESETS = [
    '#0F766E', // teal (default)
    '#0369A1', // sky
    '#1D4ED8', // blue
    '#0891B2', // cyan
    '#047857', // emerald
    '#4D7C0F', // lime
    '#B45309', // amber
    '#C2410C', // orange
    '#B91C1C', // red
    '#BE185D', // pink
    '#334155', // slate
    '#57534E', // stone
];

const THEME_SPEC = {
    primary:    { type: 'color', default: '#0F766E', presets: THEME_PRIMARY_PRESETS },
    // Optional — see the docblock. `null` is the documented way to clear one.
    accent:     {
        type: 'color', optional: true, default: null, presets: THEME_PRIMARY_PRESETS,
        description: 'call-to-action colour (primary buttons, form submits); unset = the primary.',
    },
    canvas:     {
        type: 'color', optional: true, default: null, presets: [],
        description: 'page ground behind the sections; unset = the platform ground.',
    },
    radius:     { type: 'enum', values: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md' },
    density:    { type: 'enum', values: ['compact', 'comfortable', 'spacious'], default: 'comfortable' },
    fontScale:  { type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
    appearance: { type: 'enum', values: ['light', 'dark', 'auto'], default: 'auto' },
};

/**
 * Coerce an arbitrary object to a complete, valid theme. Unknown keys are
 * dropped and invalid values fall back to the spec default, so the result is
 * always safe to hand to a renderer — there is no "partially themed" state.
 * The optional colours are the one exception, on purpose: unset or invalid
 * means ABSENT, never a default, so their fallback stays the consumer's.
 */
function canonicalizeTheme(theme) {
    const out = {};
    const src = (theme && typeof theme === 'object' && !Array.isArray(theme)) ? theme : {};
    for (const [key, spec] of Object.entries(THEME_SPEC)) {
        const v = src[key];
        const ok = spec.type === 'color'
            ? (typeof v === 'string' && HEX_RE.test(v))
            : spec.values.includes(v);
        if (ok) { out[key] = v; continue; }
        if (spec.optional) continue;
        out[key] = spec.default;
    }
    return out;
}

/** Issue records `[{ code, path, message, hint }]`; empty = valid. */
function validateTheme(theme, pathPrefix = 'theme') {
    const issues = [];
    if (theme === undefined || theme === null) return issues; // defaults apply
    if (typeof theme !== 'object' || Array.isArray(theme)) {
        return [{ code: 'theme_shape', path: pathPrefix, message: 'theme must be an object.', hint: `Use the keys: ${Object.keys(THEME_SPEC).join(', ')}.` }];
    }
    for (const [key, value] of Object.entries(theme)) {
        const spec = THEME_SPEC[key];
        if (!spec) {
            issues.push({ code: 'theme_unknown_key', path: `${pathPrefix}.${key}`, message: `Unknown theme key "${key}".`, hint: `Use one of: ${Object.keys(THEME_SPEC).join(', ')}.` });
            continue;
        }
        if (spec.type === 'color') {
            if (value === null && spec.optional) continue; // "clear it" — legal
            if (typeof value !== 'string' || !HEX_RE.test(value)) {
                issues.push({ code: 'theme_color', path: `${pathPrefix}.${key}`, message: `"${key}" must be a #rrggbb colour${spec.optional ? ' (or null to clear it)' : ''}.`, hint: 'Use a 6-digit hex literal like #0F766E.' });
            }
        } else if (!spec.values.includes(value)) {
            issues.push({ code: 'theme_enum', path: `${pathPrefix}.${key}`, message: `"${key}" must be one of ${spec.values.join(', ')}.`, hint: `Got ${JSON.stringify(value)}.` });
        }
    }
    return issues;
}

module.exports = { HEX_RE, THEME_SPEC, THEME_PRIMARY_PRESETS, canonicalizeTheme, validateTheme };

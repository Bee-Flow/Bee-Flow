/**
 * App Studio inspector: the style-knob vocabulary.
 *
 * server/appStudio/componentSpecs.js is AUTHORITATIVE for everything in this
 * file (STYLE_KNOBS ranges, per-type styleKnobs lists, section knobs, theme
 * spec, toast tones, input types, events). The values come from
 * runtime/catalogSnapshot.generated.json, written from that spec by
 * scripts/gen-app-catalog.mjs (`npm run gen:shared`), so the inspector renders
 * offline without a hand mirror. Only the labels are kept here.
 */

import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { KIND_OPTIONS } from './actionKindCatalog';
import type { StyleKnobTable, UnitRange } from './styleKnobMeta.types';
import { STYLE_KNOB_LABELS } from '../runtime/styleKnobHandlers';
import {
    advancedHeightKnobs,
    advancedWidthKnobs,
    colorRoles,
    formulaScopeRoots,
    inputTypes,
    responsiveVisibilityKnobs,
    screenDefaults,
    screenEnums,
    styleKnobs,
    themeEnums,
    toastTones,
    typeStyleKnobs,
} from '../runtime/catalogSnapshot.generated.json';

export const COLOR_ROLES: string[] = colorRoles;

// The closed visual vocabulary. Sliders take min/max/step from here; enum
// knobs render their `values`.
export const STYLE_KNOBS = styleKnobs as StyleKnobTable;

// These four are DERIVED, never listed in a type's styleKnobs: a type gets the
// width pair when it has `span` and the height pair when it has `height`; the
// responsive-visibility pair is derived from span too (a type without a grid
// cell has nothing to hide).
const ADVANCED_WIDTH_KNOBS: string[] = advancedWidthKnobs;
const ADVANCED_HEIGHT_KNOBS: string[] = advancedHeightKnobs;
const RESPONSIVE_VISIBILITY_KNOBS: string[] = responsiveVisibilityKnobs;

/**
 * What each knob is CALLED in the inspector.
 *
 * One map, deliberately: StyleSection and MultiInspector each kept their own
 * copy, both were missing `border`, and the two failed differently — the single
 * panel rendered an anonymous None/Subtle/Default control (FormField skips the
 * <label> when it gets undefined) while the multi-selection captioned it with
 * the literal string "undefined". knobLabel() falls back to the key, so the
 * next knob added to STYLE_KNOBS shows its own name rather than nothing.
 */
const BASE_KNOB_KEYS: Record<string, [string, string]> = {
    span: ['studio_apps_insp.knobs.span', 'Width'],
    size: ['studio_apps_insp.knobs.size', 'Size'],
    align: ['studio_apps_insp.knobs.align', 'Align'],
    color: ['studio_apps_insp.knobs.color', 'Color'],
    radius: ['studio_apps_insp.knobs.radius', 'Corners'],
    padding: ['studio_apps_insp.knobs.padding', 'Padding'],
    gap: ['studio_apps_insp.knobs.gap', 'Gap'],
    weight: ['studio_apps_insp.knobs.weight', 'Weight'],
    height: ['studio_apps_insp.knobs.height', 'Height'],
    background: ['studio_apps_insp.knobs.background', 'Background'],
    border: ['studio_apps_insp.knobs.border', 'Border'],
    widthMode: ['studio_apps_insp.knobs.width_mode', 'Width unit'],
    widthValue: ['studio_apps_insp.knobs.width_value', 'Exact width'],
    heightMode: ['studio_apps_insp.knobs.height_mode', 'Height unit'],
    heightValue: ['studio_apps_insp.knobs.height_value', 'Exact height'],
    hideBelow: ['studio_apps_insp.knobs.hide_below', 'Hide below'],
    hideAbove: ['studio_apps_insp.knobs.hide_above', 'Hide from'],
};

// The knobs of a group added after the base are named by the group's own file (runtime/styleKnobs/<group>.ts `labels`).
const KNOB_KEYS: Record<string, [string, string]> = { ...STYLE_KNOB_LABELS, ...BASE_KNOB_KEYS };

export const KNOB_LABELS: Record<string, string> = Object.fromEntries(Object.entries(KNOB_KEYS).map(([k, [, en]]) => [k, en]));

/** `t` is optional: without it (tests, non-UI callers) the English label comes back. */
export function knobLabel(knob: string, t: TranslateFn | null = null): string {
    const entry = KNOB_KEYS[knob];
    if (entry) return t ? t(entry[0], entry[1]) : entry[1];
    return String(knob).charAt(0).toUpperCase() + String(knob).slice(1);
}

// Human labels for enum values (fall back to the capitalised value). Advanced
// sizing units: 'span'/'preset' are the defaults, so they read as "the
// ordinary control above still owns this", not as an off switch.
const VALUE_KEYS: Record<string, [string, string]> = {
    sm: ['studio_apps_insp.values.sm', 'S'],
    md: ['studio_apps_insp.values.md', 'M'],
    lg: ['studio_apps_insp.values.lg', 'L'],
    start: ['studio_apps_insp.values.start', 'Left'],
    center: ['studio_apps_insp.values.center', 'Center'],
    end: ['studio_apps_insp.values.end', 'Right'],
    regular: ['studio_apps_insp.values.regular', 'Regular'],
    medium: ['studio_apps_insp.values.medium', 'Medium'],
    semibold: ['studio_apps_insp.values.semibold', 'Semibold'],
    auto: ['studio_apps_insp.values.auto', 'Auto'],
    none: ['studio_apps_insp.values.none', 'None'],
    full: ['studio_apps_insp.values.full', 'Full'],
    surface: ['studio_apps_insp.values.surface', 'Surface'],
    tint: ['studio_apps_insp.values.tint', 'Tint'],
    panel: ['studio_apps_insp.values.panel', 'Panel'],
    gradient: ['studio_apps_insp.values.gradient', 'Gradient'],
    span: ['studio_apps_insp.values.span', 'Columns'],
    preset: ['studio_apps_insp.values.preset', 'Preset'],
    px: ['studio_apps_insp.values.px', 'px'],
    pct: ['studio_apps_insp.values.pct', '%'],
    vh: ['studio_apps_insp.values.vh', 'vh'],
};

export function valueLabel(v: string | number, t: TranslateFn | null = null): string {
    const entry = Object.prototype.hasOwnProperty.call(VALUE_KEYS, v) ? VALUE_KEYS[v] : null;
    if (entry) return t ? t(entry[0], entry[1]) : entry[1];
    return String(v).charAt(0).toUpperCase() + String(v).slice(1);
}

// Each type's `styleKnobs` list in COMPONENT_SPECS; EVERY catalog type appears.
export const TYPE_STYLE_KNOBS: Record<string, string[]> = typeStyleKnobs;

// Shared with the server catalog (server/shared/appDefinition/sectionStyle.mjs).
export { SECTION_STYLE_KNOBS, SECTION_STYLE_DEFAULTS } from '@shared/appDefinition/sectionStyle.mjs';

// The enum-valued THEME_SPEC fields; the preset hex list lives in
// runtime/themeVars.js (APP_COLOR_PRESETS): import it from there.
export const THEME_ENUMS: Record<string, string[]> = themeEnums;

// The enum-valued SCREEN_SPEC fields the screen settings offer.
//
// These were AI-builder-only for a long time: updateScreen has always accepted
// the whole patch, but the only caller passed { name }. So an app defaulted to
// maxWidth 'medium' (960px) and there was no hand-editable way out of it: on a
// wide monitor the app used a third of the screen and the author could do
// nothing about it.
export const SCREEN_ENUMS = {
    maxWidth: screenEnums.maxWidth,
    refreshInterval: screenEnums.refreshInterval,
};
export const SCREEN_DEFAULTS = {
    maxWidth: screenDefaults.maxWidth,
    refreshInterval: screenDefaults.refreshInterval,
    showInNav: screenDefaults.showInNav,
};

// The action kinds the inspector can wire, DERIVED from the one catalog rather
// than typed out again.
//
// This used to be a hand-maintained list of seven with a comment saying the
// rest were "authored by the AI builder, not here" — which had stopped being
// true (open_modal and sequence were both in the select), while send_email and
// close_modal were missing from the list AND from the comment. Three lists,
// three answers. actionKinds.lockstep.test.js now pins all of them, and this
// one cannot drift because it is computed.
export const ACTION_KINDS = KIND_OPTIONS.map((o) => o.value);
export const TOAST_TONES: string[] = toastTones;

export { TYPE_EVENT_LISTS } from './typeEventLists';

// Which event slot the inspector's Actions section can WIRE today. This stays
// limited to onClick/onSubmit because state/definitionOps.setNodeEvent only
// accepts those two; widening it (row/card events) needs setNodeEvent +
// ActionsSection changes — until then the AI builder wires row/card events.
export const TYPE_EVENTS: Record<string, string> = { button: 'onClick', form: 'onSubmit' };

/**
 * Every root a formula may start with. The expression editor's inline
 * autocomplete completes exactly these, so what it offers is what the engine
 * accepts.
 *
 * Bundled rather than read from the catalog response on purpose: the catalog
 * arrives through react-query, and requiring a QueryClientProvider around every
 * field that happens to hold a formula would push a network concern into leaf
 * components.
 */
export const FORMULA_SCOPE_ROOTS: string[] = formulaScopeRoots;

// Types that collect a form value (the spec's isInput classification).
export const INPUT_TYPES: string[] = inputTypes;

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Knob list for a component type (empty array for unknown types). */
export function getKnobsForType(type?: string | null): string[] {
    return (type == null ? undefined : TYPE_STYLE_KNOBS[type]) || [];
}

/**
 * The advanced sizing knobs a knob list earns, as expandStyleKnobs() in
 * componentSpecs.js derives them. Width refines `span`, height refines `height`, so a
 * type that cannot express the basic knob never offers the advanced one
 * (a `tab` has neither; a section has height but no span).
 */
export function advancedKnobsFor(knobs?: string[] | null): string[] {
    const list = Array.isArray(knobs) ? knobs : [];
    return [
        ...(list.includes('span') ? ADVANCED_WIDTH_KNOBS : []),
        ...(list.includes('height') ? ADVANCED_HEIGHT_KNOBS : []),
        ...(list.includes('span') ? RESPONSIVE_VISIBILITY_KNOBS : []),
    ];
}

/** The unit a *Value knob is measured in right now (its *Mode sibling, or the default). */
export function effectiveSizeMode(style: Record<string, unknown> | null | undefined, knobName: string): string | null {
    const spec = STYLE_KNOBS[knobName];
    if (!spec || spec.type !== 'unitInt') return null;
    const modeSpec = STYLE_KNOBS[spec.modeKnob];
    const v = (style || {})[spec.modeKnob];
    return typeof v === 'string' && modeSpec.values.includes(v) ? v : modeSpec.default;
}

/** The min/max/step for a unitInt knob under `mode` — null when that mode carries no value. */
export function unitRange(knobName: string, mode?: string | null): UnitRange | null {
    const spec = STYLE_KNOBS[knobName];
    if (!spec || spec.type !== 'unitInt') return null;
    return (mode == null ? undefined : spec.units[mode]) || null;
}

/**
 * Clamp a knob value to the server's vocabulary so a bad slider event can
 * never commit an out-of-range value (the server clamps again — this just
 * keeps the live preview honest).
 *
 * `style` is only consulted for the unitInt pairs, whose legal range depends on
 * the unit their *Mode sibling names (40..2000 px vs 5..100 %).
 */
function clampUnitInt(knob: string, value: unknown, style: Record<string, unknown> | null | undefined): number | null {
    if (value === null || value === undefined) return null;   // the "not set" state
    const range = unitRange(knob, effectiveSizeMode(style, knob));
    if (!range) return null;                                  // this mode carries no value at all
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return range.default;
    return Math.max(range.min, Math.min(range.max, n));
}

export function clampKnob(knob: string, value: unknown, style: Record<string, unknown> | null = null): unknown {
    const spec = STYLE_KNOBS[knob];
    if (!spec) return value;
    if (spec.type === 'unitInt') return clampUnitInt(knob, value, style);
    if (spec.type === 'int') {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return spec.default;
        return Math.max(spec.min, Math.min(spec.max, n));
    }
    if (spec.type === 'enum') {
        return spec.values.includes(value) ? value : spec.default;
    }
    if (spec.type === 'colorOrRole') {
        if (value == null) return null;
        if (spec.roles.includes(value)) return value;
        if (typeof value === 'string' && HEX_RE.test(value)) return value;
        return null;
    }
    return value;
}

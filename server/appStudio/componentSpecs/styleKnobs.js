/**
 * App Studio catalog — the visual vocabulary: the theme re-export, the closed
 * set of style knobs, the derived advanced-sizing knobs, and the height
 * predicates canonicalize/validate thread through the component walk.
 */

'use strict';

// ---------------------------------------------------------------------------
// Theme — the entire theme. One picker restyles the whole app.
// ---------------------------------------------------------------------------

// The theme vocabulary now lives in core/themeSpec.js — the automation form
// trigger themes its hosted page with the SAME five knobs, and automation may
// not depend on appStudio (see appTriggerContract.js). Re-exported unchanged
// so every existing `require('./componentSpecs').THEME_SPEC` still resolves.
const { HEX_RE, THEME_SPEC, THEME_PRIMARY_PRESETS } = require('../../core/cms/themeSpec');

// ---------------------------------------------------------------------------
// Style knobs — the closed vocabulary of visual editing. Sliders in the
// inspector get their min/max/step from here; the validator clamps to it.
// `color` accepts null (inherit theme), a role name, or a #rrggbb literal.
// ---------------------------------------------------------------------------

const COLOR_ROLES = ['primary', 'neutral', 'success', 'warning', 'danger', 'info'];

/**
 * Push a value INTO a text field from outside the form.
 *
 * Whenever the bound value changes (and is not undefined) it replaces what is in
 * the field; the user then edits it freely. This one prop is what makes both an
 * "AI draft" button and a canned-reply picker work with no new step kinds and no
 * composer component: each writes a variable (ai_generate's resultVar, or
 * set_variable) and the field reads it back through a formula.
 */
const VALUE_FROM = { type: 'binding', default: { kind: 'static', value: null } };

const STYLE_KNOBS = {
    span:       { type: 'int', min: 1, max: 12, step: 1, default: 12 },
    size:       { type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
    align:      { type: 'enum', values: ['start', 'center', 'end'], default: 'start' },
    color:      { type: 'colorOrRole', roles: COLOR_ROLES, default: null },
    radius:     { type: 'enum', values: [null, 'none', 'sm', 'md', 'lg', 'full'], default: null },
    padding:    { type: 'int', min: 0, max: 6, step: 1, default: 0 },   // spacing steps × density
    gap:        { type: 'int', min: 0, max: 6, step: 1, default: 3 },
    weight:     { type: 'enum', values: ['regular', 'medium', 'semibold'], default: 'regular' },
    // 'fill' has no fixed pixel size: it takes whatever height is left over.
    // Inside a `pane` that means "this is the part that grows"; on a section it
    // means "this screen is a full-height layout". It is the one knob that makes
    // an independently scrolling sidebar/detail split expressible at all.
    // 'xl' exists for document viewers: 'lg' (320px) shows a technical
    // drawing as a postage stamp, and 'fill' collapses inside a tab whose
    // ancestors are not full-height.
    height:     { type: 'enum', values: ['auto', 'sm', 'md', 'lg', 'xl', 'fill'], default: 'auto' },
    // 'panel'/'gradient' are the look-pass additions: panel = the recessed
    // grouping surface (--bg-secondary family), gradient = a soft wash out of
    // the app's primary. Appended AFTER the originals on purpose — 'none'
    // stays first (= default), so every stored section and card renders
    // byte-identically, and the runtime background resolver returns null for
    // values it does not know yet, so an older client paints nothing rather
    // than something wrong.
    background: { type: 'enum', values: ['none', 'surface', 'tint', 'panel', 'gradient'], default: 'none' },
    // A card draws no outline of its own. In the high-contrast theme --bg-card
    // and --bg-primary are BOTH #000000, so a card there is not subtle — it is
    // invisible, and every grouping the layout depends on disappears with it.
    // (Deliberately not a `shadow` knob: --shadow-sm is a RING in high contrast,
    // so its meaning flips per theme.)
    border:     { type: 'enum', values: ['none', 'subtle', 'default'], default: 'none' },

    // ── Responsive visibility ──────────────────────────────────────────────
    // CSS-only: the resolver emits app-hide-below-<b>/app-hide-above-<b>
    // classes and runtime.css carries the media rules, so nothing re-renders
    // on resize and 'none' (first = identity) emits no class at all. Bands
    // mirror the runtime.css breakpoints: sm=640px, md=1024px, lg=1280px —
    // hideBelow 'md' hides the node on viewports NARROWER than 1024px,
    // hideAbove 'md' hides it at 1024px and wider. Availability is DERIVED
    // from `span` (expandStyleKnobs below), like the width pair.
    hideBelow:  { type: 'enum', values: ['none', 'sm', 'md', 'lg'], default: 'none' },
    hideAbove:  { type: 'enum', values: ['none', 'sm', 'md', 'lg'], default: 'none' },

    // ── Advanced sizing ────────────────────────────────────────────────────
    // The column slider covers "a third of the row" and nothing else. A logo
    // strip that must be 180px, a signature block that must be 60% of its
    // card — those had no expression at all, and authors reached for a
    // 12-column approximation that was wrong on every viewport but one.
    //
    // The split is deliberate and is the whole contract:
    //   the GRID owns PLACEMENT, the value owns the BOX.
    // widthMode 'px'/'pct' never touches `gridColumn` — `span` keeps deciding
    // how much of the row the CELL reserves (and therefore what sits beside
    // it), and widthValue decides how wide the painted box is INSIDE that
    // cell. Collapsing the cell to fit the box instead would make two
    // px-sized siblings reflow unpredictably and make the column slider look
    // broken; this way both knobs stay live and composable, and a pct width
    // has a definite thing to be a percentage OF (the cell).
    //
    // Every emitted width is paired with max-width:100% in the resolver, and
    // runtime.css re-asserts that below 640px, so an explicit width can never
    // out-argue the mobile stack.
    widthMode:  { type: 'enum', values: ['span', 'px', 'pct'], default: 'span' },
    widthValue: {
        type: 'unitInt', modeKnob: 'widthMode', default: null,
        units: {
            px:  { min: 40, max: 2000, step: 10, default: 320 },
            pct: { min: 5,  max: 100,  step: 5,  default: 50 },
        },
    },
    // heightMode 'preset' IS the `height` enum above, untouched — including
    // 'fill'. 'px'/'vh' are the escape hatches ('vh' is what "half the screen"
    // actually means).
    //
    // 'pct' is conditional, on purpose: a percentage height only resolves
    // against a parent that HANDS A DEFINITE HEIGHT DOWN, otherwise CSS treats
    // it as auto and the knob silently does nothing. That is a stricter test
    // than "the parent has a height": the parent's height lands on its grid
    // cell, and a card or container leaves an auto-height wrapper between that
    // cell and its children unless it is filling. validate.js therefore rejects
    // heightMode 'pct' unless containerPassesHeightDown says the enclosing
    // section/container really passes one on, and rejects it outright on a
    // section — a section is a flex item in the screen's auto-height stack,
    // so there is never anything for its percentage to measure.
    heightMode: { type: 'enum', values: ['preset', 'px', 'pct', 'vh'], default: 'preset' },
    heightValue: {
        type: 'unitInt', modeKnob: 'heightMode', default: null,
        units: {
            px:  { min: 24, max: 4000, step: 10, default: 240 },
            pct: { min: 5,  max: 100,  step: 5,  default: 50 },
            vh:  { min: 5,  max: 100,  step: 5,  default: 50 },
        },
    },
};

// ---------------------------------------------------------------------------
// Advanced sizing — DERIVED knob availability.
//
// These derived knobs are not listed in any type's `styleKnobs`, and that is the
// design: they are refinements OF `span` and `height`, so a type gets them
// exactly when it already has the knob they refine. Deriving beats copying —
// the alternative was appending four strings to ~50 literal arrays (and to the
// frontend mirror, and to the AI catalog), where the one that got forgotten
// would reject a perfectly good width with "does not apply to this component".
//
// canonicalize.js and validate.js run every allowed-key check through
// expandStyleKnobs(); the per-type lists stay EXACTLY as they were, so the
// frontend mirror and the prompt catalog need no churn.
// ---------------------------------------------------------------------------

const ADVANCED_WIDTH_KNOBS = Object.freeze(['widthMode', 'widthValue']);
const ADVANCED_HEIGHT_KNOBS = Object.freeze(['heightMode', 'heightValue']);
// The hide pair rides with `span` for the same reason the width pair does: it
// acts on the node's grid cell, and a type without a cell (tab, modal) has no
// box of its own to hide per band.
const RESPONSIVE_VISIBILITY_KNOBS = Object.freeze(['hideBelow', 'hideAbove']);

const _expandedKnobCache = new WeakMap();

/** A type's (or the section's) style knobs plus the advanced sizing knobs it earns. */
function expandStyleKnobs(knobs) {
    if (!Array.isArray(knobs)) return [];
    const cached = _expandedKnobCache.get(knobs);
    if (cached) return cached;
    let out = knobs;
    if (knobs.includes('span')) out = out.concat(ADVANCED_WIDTH_KNOBS, RESPONSIVE_VISIBILITY_KNOBS);
    if (knobs.includes('height')) out = out.concat(ADVANCED_HEIGHT_KNOBS);
    _expandedKnobCache.set(knobs, out);
    return out;
}

/** The min/max/step for a unitInt knob under `mode`, or null when that mode carries no value. */
function unitRange(knobName, mode) {
    const knob = STYLE_KNOBS[knobName];
    if (!knob || knob.type !== 'unitInt') return null;
    return knob.units[mode] || null;
}

/** The widest range a unitInt knob can ever hold — the clamp for an inert value. */
function unitSpan(knobName) {
    const knob = STYLE_KNOBS[knobName];
    if (!knob || knob.type !== 'unitInt') return null;
    const ranges = Object.values(knob.units);
    return {
        min: Math.min(...ranges.map((r) => r.min)),
        max: Math.max(...ranges.map((r) => r.max)),
    };
}

/**
 * The `height` presets a box can be definite BY.
 *
 * 'sm'|'md'|'lg'|'xl' are literal pixel counts (styleResolver HEIGHT_PX), so
 * they are definite wherever they appear. 'fill' is NOT, and used to be listed
 * as if it were: it renders as `h-full` / `flex-1`, and 100% of an indefinite
 * parent is indefinite — a 'fill' card in an auto-height section has exactly as
 * little height as the section does. So it is definite only inside a chain that
 * already is, which is what `parentDefinite` below now decides.
 *
 * The combined list stays the author-facing vocabulary ("the heights that can
 * carry a percentage"); the builder catalog renders it.
 */
const FIXED_HEIGHT_PRESETS = Object.freeze(['sm', 'md', 'lg', 'xl']);
const DEFINITE_HEIGHT_PRESETS = Object.freeze([...FIXED_HEIGHT_PRESETS, 'fill']);

/**
 * Does this box have a definite height OF ITS OWN?
 *
 * `parentDefinite` makes it recursive, and it governs 'fill' exactly as it
 * governs 'pct': both are relative sizes — a percentage of, or the leftover of,
 * the box above — so each is only as definite as its parent. 50%-of-50% works
 * under a real height and collapses under auto; so does fill-inside-auto.
 *
 * This answers "is this box definite", NOT "can its children measure against
 * it". The wrapper a container renders between its cell and its children
 * decides that, and most of them drop the height — see containerPassesHeightDown,
 * which is what the validator actually threads through the walk.
 */
function styleHeightIsDefinite(style, parentDefinite = false) {
    if (!style || typeof style !== 'object') return false;
    const mode = style.heightMode;
    if (mode === 'px' || mode === 'vh') return Number.isFinite(style.heightValue);
    if (mode === 'pct') return parentDefinite && Number.isFinite(style.heightValue);
    if (style.height === 'fill') return parentDefinite;
    return FIXED_HEIGHT_PRESETS.includes(style.height);
}

/**
 * Is this the node the runtime treats as a FILL node?
 *
 * Mirrors isFill() in agent-hub/.../AppStudio/runtime/styleResolver.js: an
 * explicit heightMode outranks a stale `height:'fill'` sitting beside it, and
 * the components key their full-height treatment off exactly that predicate.
 */
function styleIsFill(style) {
    if (!style || typeof style !== 'object') return false;
    const mode = style.heightMode;
    const explicit = (mode === 'px' || mode === 'pct' || mode === 'vh') && Number.isFinite(style.heightValue);
    return !explicit && style.height === 'fill';
}

/**
 * How a container hands its own height DOWN to its children.
 *
 * A resolved height lands on the node's GRID CELL (AppRenderer →
 * resolveNodeStyle), and every container renders its own wrapper between that
 * cell and the children. A percentage child can only measure against a wrapper
 * that is itself full-height, so the cell's height is not the question — the
 * wrapper is:
 *
 *   'always' — `pane`: `h-full` unconditionally (AppPane.jsx), so whatever
 *              definite height the pane has reaches its children.
 *   'fill'   — `card`, `container`, `tabs` and `tab`: `h-full min-h-0` /
 *              `flex-1 min-h-0` are added ONLY on the fill path (AppCard.jsx,
 *              AppContainer.jsx, AppTabs.jsx, AppTab.jsx). At `height:'md'` —
 *              or heightMode 'px' — the cell is a real 200px and the wrapper
 *              inside it is still auto, so a `50%` child resolves to auto and
 *              collapses. That was shipped as legal; it is the bug this route
 *              exists to state.
 *   absent   — `form`, `modal`, `repeater`, `page_header`: no `height` knob at
 *              all, so there is never a height to pass on.
 *
 * `tabs`/`tab` earned their knob late: without it the tab strip was the one
 * place a full-height chain always died, so every tabbed work surface had to
 * guess a pixel number for its content and left dead space below it on a large
 * monitor. Both are 'fill' rather than 'always' because a tab panel is only
 * stretched on the fill path — a `tabs` at height 'md' is a fixed box that
 * scrolls, exactly like a card.
 *
 * This map and those components are one fact written twice; the componentSpecs
 * test pins its keys against the container types that own a `height` knob, so a
 * new height-bearing container cannot quietly default into either answer.
 */
const CONTAINER_HEIGHT_ROUTES = Object.freeze(Object.assign(Object.create(null), {
    pane: 'always',
    card: 'fill',
    container: 'fill',
    tabs: 'fill',
    tab: 'fill',
}));

/** 'always' | 'fill' | null — how `type` passes a height down (or does not). */
function containerHeightRoute(type) {
    return CONTAINER_HEIGHT_ROUTES[type] || null;
}

/**
 * Can a child of this container use a percentage height?
 *
 * Two conditions, and both are needed: the container's own box must be
 * definite, AND the container must thread it through its wrapper. The 'fill'
 * route collapses both into one check — a fill node's wrapper is `h-full`, and
 * `h-full` is only a height if the cell above it already is.
 */
function containerPassesHeightDown(type, style, parentDefinite = false) {
    const route = containerHeightRoute(type);
    if (!route) return false;
    if (route === 'fill') return styleIsFill(style) && parentDefinite;
    return styleHeightIsDefinite(style, parentDefinite);
}

/**
 * A SECTION's height, as its children see it.
 *
 * A section IS the grid its children sit in — nothing is rendered in between —
 * so its own definiteness is what they measure against. Two deviations from the
 * node rule, both of them AppRenderer facts:
 *   - 'fill' counts: a screen that holds a fill section grows the full-height
 *     wrapper chain above it (`hasFillSection`), so the section's parent is
 *     definite by construction.
 *   - 'pct' never counts: it is refused on a section, and the resolver declines
 *     to emit it (resolveSectionHeightCss), so it never reaches the DOM at all.
 */
function sectionHeightIsDefinite(style) {
    if (!style || typeof style !== 'object') return false;
    if (style.heightMode === 'pct') return false;
    return styleHeightIsDefinite(style, true);
}

module.exports = {
    HEX_RE,
    THEME_SPEC,
    THEME_PRIMARY_PRESETS,
    COLOR_ROLES,
    VALUE_FROM,
    STYLE_KNOBS,
    ADVANCED_WIDTH_KNOBS,
    ADVANCED_HEIGHT_KNOBS,
    RESPONSIVE_VISIBILITY_KNOBS,
    expandStyleKnobs,
    unitRange,
    unitSpan,
    FIXED_HEIGHT_PRESETS,
    DEFINITE_HEIGHT_PRESETS,
    styleHeightIsDefinite,
    styleIsFill,
    CONTAINER_HEIGHT_ROUTES,
    containerHeightRoute,
    containerPassesHeightDown,
    sectionHeightIsDefinite,
};

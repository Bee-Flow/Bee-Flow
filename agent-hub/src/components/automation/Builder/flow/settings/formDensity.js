import { createContext, useContext } from 'react';
import { NODE_DEFS } from '../nodeDefs';

/**
 * TWO independent axes decide what a step's editor shows:
 *
 *   density — how BIG the drawer is. A double click forces 'full'; a single
 *             click reopens at the density the drawer was LEFT in, which the
 *             shell remembers per user (see densityForOpen below):
 *     'quick' — the small drawer, Settings only.
 *     'full'  — the Incoming | Settings | Continues-on workspace.
 *
 *   mode    — how MUCH of the form exists. Owned by the USER via the
 *             Simple / All-options toggle, persisted per user
 *             (useFormModePreference):
 *     'simple'   — only the sections this step type needs, per
 *                  NODE_DEFS[type].simpleSections.
 *     'advanced' — every section.
 *     null       — the user has never touched the toggle; resolveMode falls
 *                  back to the gesture (quick → simple, full → advanced), so
 *                  behaviour with no stored preference is exactly the old one.
 *
 * Sections that hold a validation ERROR are always rendered regardless — a
 * problem the user cannot reach is worse than a busy panel. Sections the user
 * has already CONFIGURED are likewise never hidden (AccordionSection's
 * `hasContent`): hiding a thing that is switched on reads as data loss.
 */

export const ADVANCED_SECTION_KEYS = new Set([
    'advanced',   // per-type "Advanced" blocks (forEach, defaultBranch, …)
    'options',    // parse_json / http_request tuning
    'headers',    // http_request
    'auth',       // http_request credentials
    'output',     // ai_step structured-output schema
]);

/** Is this section hidden at the given density? */
export function isAdvancedSection(sectionKey) {
    return ADVANCED_SECTION_KEYS.has(sectionKey);
}

/** The two user-facing form modes. Persisted values are validated against this. */
export const FORM_MODES = ['simple', 'advanced'];

/**
 * Which mode a form effectively renders in. The user's explicit choice wins;
 * with no choice stored (mode null/undefined) the gesture decides, exactly as
 * before the toggle existed.
 */
export function resolveMode({ mode, density } = {}) {
    return mode === 'simple' || mode === 'advanced'
        ? mode
        : (density === 'quick' ? 'simple' : 'advanced');
}

/**
 * Is `sectionKey` hidden for this step type in Simple mode?
 *
 * Per-type first: NODE_DEFS[type].simpleSections names the sections that make
 * the step WORK for that type — "simple" means something different for a
 * web-service call than for an AI step. Types with no per-type list (engine-
 * only types, anything new) fall through to the global ADVANCED_SECTION_KEYS
 * rule — that fallback is the documented default, not an omission.
 */
export function hiddenInSimple(stepType, sectionKey) {
    const simple = NODE_DEFS[stepType]?.simpleSections;
    if (Array.isArray(simple)) return !simple.includes(sectionKey);
    return isAdvancedSection(sectionKey);
}

/**
 * Which density an "open this node" request resolves to.
 *
 * An explicit 'full' (the double click) always wins. A single click asks for
 * nothing and gets the density the drawer was LEFT in — `remembered`, the
 * user's last quick/full choice, which BuilderShell persists. Design 1h let
 * the gesture decide alone; the user asked for "open it how I opened it
 * before" (2026-09-03): the ⤢ / shrink buttons and the column toggles set
 * the memory (the Incoming / Continues-on states were already remembered),
 * and a double click still forces the full view.
 */
export function densityForOpen(requested, remembered = null) {
    if (requested === 'full') return 'full';
    return remembered === 'full' ? 'full' : 'quick';
}

/**
 * `density` + `mode` are what sections read (resolve them via resolveMode).
 * `onHiddenSection(key)` lets the host count what it is hiding, so the
 * "Show all options (3)" control can name a number instead of promising
 * something that may not exist; `onShownSection(key)` is the symmetric report
 * when a previously-hidden section becomes visible, so the count can go DOWN
 * as well as up.
 */
export const FormDensityContext = createContext({
    density: 'full', mode: null, onHiddenSection: null, onShownSection: null,
});

export function useFormDensity() {
    return useContext(FormDensityContext);
}

/** The RESOLVED mode for the current form. */
export function useFormMode() {
    return resolveMode(useContext(FormDensityContext));
}

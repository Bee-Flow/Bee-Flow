/**
 * App Studio catalog — the screen table, the closed set of node event names,
 * and the section's own style knobs/defaults.
 */

'use strict';

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const SCREEN_SPEC = {
    name: { type: 'string', required: true, maxLen: 60, default: 'Screen' },
    icon: { type: 'icon', default: null },
    showInNav: { type: 'boolean', default: true },
    maxWidth: { type: 'enum', values: ['narrow', 'medium', 'wide', 'full'], default: 'medium' },
    // v2 (optional): a layout hint for the renderer; visibleToRoles gates the
    // whole screen by role KEY (role definitions live server-side, not here).
    kind: { type: 'enum', values: [null, 'dashboard'], default: null },
    // v3 (optional): one line saying what the screen is FOR. Written once,
    // shown in four places — the mega-menu panel, the mobile drawer, the
    // sidebar tooltip when collapsed, and the screen inspector. Short on
    // purpose: it is a subtitle under a menu item, not documentation.
    description: { type: 'string', maxLen: 120, default: null },
    // Seconds between background refetches of every data binding on this screen;
    // 0 is off. Set per SCREEN rather than per component on purpose: components
    // reading the same rows share one cache entry, so two different intervals on
    // one screen would fight and whichever mounted last would win.
    // The runtime never polls in the editor and pauses while the tab is hidden.
    refreshInterval: { type: 'enum', values: [0, 15, 30, 60, 300], default: 0 },
};

// The closed set of node/component EVENT names. Which ones a given type may
// carry is declared per-type via spec.events; canonicalize/validate iterate
// this list so adding an event type here wires both without further edits.
// onCardMove (kanban drag-drop) fires with { item: <moved row>, value:
// <target column value> } in the triggering form scope.
// onChange fires when a DISCRETE input's value changes (select, checkbox, date,
// multiselect) and hands the whole form's values to the action. Deliberately not
// offered on text fields: that would run an action on every keystroke. It is
// what makes a triage bar — pick a status, it saves — instead of a row of
// dropdowns behind a Save button.
const EVENT_NAMES = ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided'];

// `height` is deliberately NOT in SECTION_STYLE_DEFAULTS: cleanStyle spreads the
// defaults into every section, so adding it there would rewrite every stored
// definition on the next save. Absent means 'auto', exactly as before.
const SECTION_STYLE_KNOBS = ['padding', 'gap', 'background', 'height'];
const SECTION_STYLE_DEFAULTS = { padding: 4, gap: 3, background: 'none' };

module.exports = {
    SCREEN_SPEC,
    EVENT_NAMES,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
};

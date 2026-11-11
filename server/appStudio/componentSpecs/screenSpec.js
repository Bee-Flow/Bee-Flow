// @typecheck strict
/**
 * App Studio catalog — the screen table, the closed set of node event names,
 * and the section's own style knobs/defaults.
 */

'use strict';

const { SCREEN_TRIGGER_KEYS } = require('./clientTriggerSpecs');

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
    // Schema 3 (optional, emit-when-present): the client triggers of a screen. Text in
    // clientTriggerSpecs.js, the shapes in shared/appDefinition/clientTriggers.mjs.
    events: SCREEN_TRIGGER_KEYS.events,
    timers: SCREEN_TRIGGER_KEYS.timers,
    // Schema 3 (optional, emit-when-present): a theme override for this screen
    // (canonicalize/scopeTheme.mts). Partial: only the keys it names differ from the app theme.
    theme: {
        type: 'object', since: 3, default: null,
        description: 'A theme of this screen that differs from the app theme. '
            + 'An object with any of the app theme keys (primary, accent, canvas as #rrggbb, radius, density, fontScale, appearance), only the ones that should differ. '
            + 'It applies to everything on the screen and to nothing else, e.g. a dark control-room screen { appearance: "dark", primary: "#38bdf8" } in a light app, or a calmer { density: "spacious", canvas: "#f5f5f4" } on a reading screen. '
            + 'The navigation bar keeps the app theme. A canvas whose text would be hard to read gets a validator warning. Set it with app_update_screen { screenId, theme: { … } } (the object replaces the one there), null removes it.',
    },
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
// onAttachmentClick (message_thread) fires with { item: <the attachment row> }.
const EVENT_NAMES = ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided', 'onAttachmentClick'];

// Shared with the editor (server/shared/appDefinition/sectionStyle.mjs); the
// reason `height` is not among the defaults is written there.
const { SECTION_STYLE_KNOBS, SECTION_STYLE_DEFAULTS } = require('../../shared/appDefinition/sectionStyle.mjs');

module.exports = {
    SCREEN_SPEC,
    EVENT_NAMES,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
};

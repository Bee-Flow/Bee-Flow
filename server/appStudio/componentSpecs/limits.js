/**
 * App Studio catalog — the hard ceilings a definition is measured against.
 * canonicalize clamps to them and validate refuses past them.
 */

'use strict';

// ---------------------------------------------------------------------------
// Hard ceilings (abuse guards; far above any real app)
// ---------------------------------------------------------------------------

const LIMITS = {
    // 40 since App Design v2: nav groups + the sidebar/overflow shells make a
    // many-screen app actually navigable — 20 was the flat-top-tabs ceiling.
    MAX_SCREENS: 40,
    MAX_SECTIONS_PER_SCREEN: 40,
    MAX_TOTAL_NODES: 500,        // sections + components across the whole app
    MAX_ACTIONS: 60,
    // v3: section → container → container → container → container → leaf.
    // Raised from 5 because at 5 a `tab` could only hold LEAF components:
    // section → pane → tabs → tab → x left no room for a page_header (itself a
    // container, holding its buttons) inside the tab. "A tabbed pane with a
    // toolbar" is the most ordinary professional layout there is, and it was
    // the one shape the limit forbade.
    MAX_DEPTH: 6,
    MAX_STRING: 5000,            // any single string prop
    MAX_DEFINITION_BYTES: 512 * 1024,
    MAX_SELECT_OPTIONS: 100,
    MAX_TABLE_COLUMNS: 12,
    MAX_KEYVALUE_FIELDS: 20,
    MAX_STATIC_ROWS: 200,
    MAX_NAME_LEN: 80,
    // v2 additions
    MAX_FORMULA_LEN: 2000,             // any single formula expression string
    MAX_VALIDATIONS_PER_FIELD: 10,     // input.validations entries
    // Raised from 30/4 (2026-08-17). These were sized for hand-written button
    // flows, and a real document pipeline outgrew them: a quote-intake
    // "process with AI" action sat at exactly 29 steps and depth 4, so it
    // could not gain a single progress update, let alone the per-document read
    // loop it needed. The caps exist to keep ONE action comprehensible and to
    // bound the client-side dispatch loop, not to cap real work — and the true
    // runtime bound is MAX_ACTION_LOOP_ITERATIONS below, which is unchanged.
    // Depth 6 matches MAX_DEPTH (component nesting) rather than inventing a
    // second number for "how deeply may things nest".
    MAX_ACTION_STEPS: 60,              // steps in one action sequence (recursive count)
    MAX_ACTION_DEPTH: 6,               // sequence nesting: condition/loop/switch branches
    MAX_ACTION_LOOP_ITERATIONS: 200,   // ceiling for loop.maxIterations
    MAX_DATA_GRID_COLUMNS: 20,         // data_grid columns
    MAX_CHART_SERIES: 12,              // chart series entries
    MAX_CHART_REFERENCES: 8,           // chart referenceLines / referenceBands entries —
                                       // a clinical range is one or two bands; past
                                       // eight the plot is annotation, not data
    MAX_ROLES: 20,                     // def.roles entries
    MAX_NAVIGATE_PARAMS: 20,           // navigate params map entries
    MAX_KANBAN_COLUMNS: 12,            // kanban columns entries (the LITERAL list;
                                       // a bound columnsSource is capped at runtime)
    MAX_KANBAN_SWIMLANES: 12,          // kanban swimlanes entries (same split)
    MAX_KANBAN_CARD_FIELDS: 6,         // kanban cardFields entries — a card that
                                       // needs a 7th field wants the detail view
    MAX_RECORD_DETAIL_FIELDS: 30,      // record_detail fields entries
    MAX_FILTER_BAR_FIELDS: 8,          // filter_bar fields entries
    MAX_STEPPER_STEPS: 10,             // stepper steps entries
    // v2.2 — declared variables (definition.variables)
    MAX_VARIABLES: 30,                 // between MAX_ROLES (20) and MAX_ACTIONS (60):
                                       // a 40-screen app with per-screen filter
                                       // state plausibly wants 20-25.
    MAX_VARIABLE_DEFAULT_BYTES: 2048,  // one seeded record/list. Exists so the
                                       // error can name the variable instead of
                                       // "your app is too big" at 512KB.
};

module.exports = {
    LIMITS,
};

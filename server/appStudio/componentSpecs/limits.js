// @typecheck strict
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
    MAX_ACTIONS: 200,            // was 60 (2026-11): per-document pipelines + helper actions
    // v3: section → container → container → container → container → leaf.
    // Raised from 5 because at 5 a `tab` could only hold LEAF components:
    // section → pane → tabs → tab → x left no room for a page_header (itself a
    // container, holding its buttons) inside the tab. "A tabbed pane with a
    // toolbar" is the most ordinary professional layout there is, and it was
    // the one shape the limit forbade.
    // 8 since 2026-11 (was 6): two wrapper levels over section→tabs→tab→modal→form→input.
    MAX_DEPTH: 8,
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
    // Depth matches MAX_DEPTH (component nesting) rather than inventing a
    // second number for "how deeply may things nest".
    // 120 since 2026-11-03 (was 60): a document pipeline with a per-document loop and its
    // progress updates sat at the old ceiling. One number for every app: there is no per-app limits mechanism.
    MAX_ACTION_STEPS: 120,             // steps in one action sequence (recursive count)
    MAX_ACTION_DEPTH: 8,               // sequence nesting: condition/loop/switch branches (8 since 2026-11, was 6; stays === MAX_DEPTH)
    MAX_ACTION_LOOP_ITERATIONS: 200,   // ceiling for loop.maxIterations
    MAX_DATA_GRID_COLUMNS: 20,         // data_grid columns
    // AI step limits (2026-11). Plain constants, not env: they decide whether a
    // definition is valid, and that must not differ per instance.
    MAX_AI_PROMPT_LEN: 32000,          // ai_generate prompt (was 8000)
    MAX_AI_SCHEMA_FIELDS: 40,          // aiSchema entries
    MAX_AI_SCHEMA_FIELD_DESC: 2000,    // one schema field description (was 500); for ai_extract it IS the instruction
    MAX_CONTEXT_SOURCES: 12,           // contextSources entries per AI step (was 4)
    MAX_CONTEXT_SOURCE_LABEL: 120,     // one contextSource label (was 60)
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
    MAX_VARIABLES: 30,                 // between MAX_ROLES (20) and MAX_ACTIONS (200):
                                       // a 40-screen app with per-screen filter
                                       // state plausibly wants 20-25.
    MAX_VARIABLE_DEFAULT_BYTES: 2048,  // one seeded record/list. Exists so the
                                       // error can name the variable instead of
                                       // "your app is too big" at 512KB.
};

module.exports = {
    LIMITS,
};

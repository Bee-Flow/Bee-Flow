// @typecheck strict
/**
 * Step kind `set_ui`: sets the state a component keeps on screen (the active tab of a tabs
 * group, whether a modal is open, the selected rows of a data_grid). The same state is read in
 * formulas under the scope root `ui` (ui.tabs.<id>.active, ui.modals.<id>.open,
 * ui.selection.<id>), which only the browser fills. Browser chrome: only a click or a public
 * page runs it.
 */

'use strict';

module.exports = {
    kind: 'set_ui',
    since: 3,
    side: 'client',
    fields: {
        nodeId: { type: 'string', required: true, maxLen: 80, description: 'The id of the tabs, modal or data_grid component.' },
        state: { type: 'enum', required: true, values: ['activeTab', 'open', 'selection'], description: 'Which state: activeTab (a tabs group), open (a modal) or selection (a data_grid).' },
        value: { type: 'binding', required: true, description: 'The new state: a tab id or 0-based position, true or false, or the row id(s) to select.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `set_ui(${String(s.nodeId || '?')}.${String(s.state || '?')})`,
    description: 'Switches a tab, opens or closes a dialog, or sets a grid selection. `state` says which: "activeTab" on a tabs component takes the id of one of its tabs (or its 0-based position), "open" on a modal takes true or false, "selection" on a data_grid takes a row id, a list of row ids or of rows with an id (an empty list or null clears it). Example: { kind: "set_ui", nodeId: "cmp_tabs", state: "activeTab", value: { kind: "static", value: "cmp_tab_details" } }. The same state is readable in every browser formula under the root ui: ui.tabs.<tabsId>.active (the id of the active tab), ui.modals.<modalId>.open (true or false), ui.selection.<gridId> (the selected rows, always a list). So a section can show only while a dialog is open, a button can be enabled only with a selection, and a records filter can follow the selected row (visibleWhen: "count(ui.selection.cmp_grid) > 0"). A component that is not mounted yet (a tab group on the screen a navigate step just opened) takes the value when it appears. The ui root is empty on the server: a server step (create_record, ai_generate, ...) must not read it, copy the value into a variable with set_variable first. Runs only in the browser: a background action, a mailbox hook and app_run_action do not run it.',
};

// @typecheck strict
/**
 * Step kind `back`: returns to the screen the visitor came from (with the params it had then).
 * Browser chrome like navigate: only a click or a public page runs it.
 */

'use strict';

module.exports = {
    kind: 'back',
    since: 3,
    side: 'client',
    fields: {},
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: () => 'back',
    description: 'Goes back to the screen the person was on before. It reopens that screen with the params it had then, so a detail screen reached from a list goes back to the list, and a detail screen opened from another record goes back to that record: { kind: "back" }. Use it for a "Back" or "Cancel" button, or after saving on a screen that several screens lead to, where navigate would have to guess. Each back steps one screen further back. When there is no earlier screen in this visit (the app was just opened) nothing happens, so put a navigate to a fixed screen in its place when a target must always exist. Runs only in the browser: a background action, a mailbox hook and app_run_action do not run it.',
};

// @typecheck strict
/**
 * Step kind `focus`: moves the keyboard focus to a component on the screen (the first field,
 * button or link inside it). Browser chrome: only a click or a public page runs it.
 */

'use strict';

module.exports = {
    kind: 'focus',
    since: 3,
    side: 'client',
    fields: {
        nodeId: { type: 'string', required: true, maxLen: 80, description: 'The id of the component to focus.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `focus(${String(s.nodeId || '?')})`,
    description: 'Moves the keyboard focus to a component on the screen. The focus lands on the first field, button or link inside the component with that node id, and the page scrolls to it: { kind: "focus", nodeId: "cmp_search" }. Use it after reset_form or set_form_field so the person can type straight on, or to point at the field a condition found wrong. A component that holds nothing focusable is only scrolled into view. A component that is not on the screen (hidden, on another screen, in a closed dialog) is skipped without an error. Runs only in the browser: a background action, a mailbox hook and app_run_action do not run it.',
};

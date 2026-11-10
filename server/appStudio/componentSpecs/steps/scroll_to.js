// @typecheck strict
/**
 * Step kind `scroll_to`: scrolls the screen to a component, or to the top with nodeId "top".
 * Browser chrome: only a click or a public page runs it.
 */

'use strict';

module.exports = {
    kind: 'scroll_to',
    since: 3,
    side: 'client',
    fields: {
        nodeId: { type: 'string', required: true, maxLen: 80, description: 'The id of the component to scroll to, or "top" for the top of the screen.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `scroll_to(${String(s.nodeId || '?')})`,
    description: 'Scrolls the screen to a component, or back to the top. { kind: "scroll_to", nodeId: "cmp_results" } brings that component into view (its top edge at the top of the window), { kind: "scroll_to", nodeId: "top" } goes back to the top of the screen. Use it after a search or a submit whose result shows further down, or to bring the person back to the top of a long form. The scroll is smooth unless the person asked their system for reduced motion. A component that is not on the screen is skipped without an error. Runs only in the browser: a background action, a mailbox hook and app_run_action do not run it.',
};

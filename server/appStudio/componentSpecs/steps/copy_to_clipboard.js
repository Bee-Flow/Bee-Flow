// @typecheck strict
/**
 * Step kind `copy_to_clipboard`: puts a text on the visitor's clipboard. Browser chrome: only
 * a click or a public page runs it, and the browser decides whether the page may write there.
 */

'use strict';

module.exports = {
    kind: 'copy_to_clipboard',
    since: 3,
    side: 'client',
    fields: {
        text: { type: 'binding', required: true, description: 'What is copied: { kind: "static", value } or a formula. A number or a list is copied as text.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: () => 'copy_to_clipboard',
    description: 'Copies a text to the person\'s clipboard. { kind: "copy_to_clipboard", text: { kind: "formula", expr: "item.reference" } } copies the reference of the clicked row. A number is copied as written, a list or record as JSON. Nothing is shown by itself: follow it with a toast ("Copied") when the person should see that it worked. When the browser refuses (no secure page, or no permission) the step fails with a message and the steps after it do not run, so put the toast after it. Runs only in the browser: a background action, a mailbox hook and app_run_action do not run it.',
};

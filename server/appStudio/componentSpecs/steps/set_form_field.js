// @typecheck strict
/**
 * Step kind `set_form_field`: puts a value into one field of a mounted form, by the form's
 * name and the input's name. Browser chrome like reset_form: it needs the visitor's page, so
 * a background job, a mailbox hook and app_run_action never run it.
 */

'use strict';

module.exports = {
    kind: 'set_form_field',
    since: 3,
    side: 'client',
    fields: {
        form: { type: 'string', required: true, maxLen: 100, description: 'The form, by name: its props.name, or its node id when it has no name (the key reset_form takes).' },
        field: { type: 'string', required: true, maxLen: 100, description: 'The input inside that form, by its props.name.' },
        value: { type: 'binding', required: true, description: 'The new value: { kind: "static", value } or { kind: "formula", expr }.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `set_form_field(${String(s.form || '?')}.${String(s.field || '?')})`,
    description: 'Puts a value into one field of a form on the screen. The input shows it at once and it is submitted with the form, exactly as if the person had typed it: { kind: "set_form_field", form: "order", field: "quantity", value: { kind: "formula", expr: "item.quantity" } }. `form` is the form\'s props.name (its node id when it has none), `field` the input\'s props.name. Typical use: a row click that fills a form with the row, a "Use my address" button, or a default worked out from other fields. The form must be mounted when the step runs (on the current screen or in an open dialog), otherwise nothing happens, and a field name the form has no input for is left alone. To empty the whole form use reset_form. Runs only in the browser: a background action, a mailbox hook and app_run_action do not run it.',
};

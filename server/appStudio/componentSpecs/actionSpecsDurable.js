// @typecheck strict
'use strict';

/**
 * Where a sequence runs (schema version 3). `runOn` is optional, marked `since: 3`, appended at the END of the
 * sequence's fields in actionSpecs.js and never written into a definition that does not use it.
 */

const SEQUENCE_RUN_ON = {
        runOn: {
            type: 'enum', values: ['server'], since: 3,
            description: 'Runs the whole sequence on the server as one run. '
                + 'Without it the page walks the steps one by one. With it the page sends one request and waits. The result and the written variables come back when the run ends, and its toasts and refreshes show then. '
                + 'Use it for a sequence that must not depend on the page staying open between steps, or whose steps wait. '
                + 'Only steps that need no page may be in it: no navigate, open_url, open_modal, close_modal, reset_form or download, and a confirm only as the first step(s). '
                + 'lockKey and progressVar work as with background. With background: true as well, the page does not wait. '
                + 'A public page and the phone app walk the steps themselves, as without it.',
        },
};

/**
 * Append the field to the sequence action, after every other field of it exists.
 * @param {Record<string, any>} actions
 */
function extend(actions) {
    Object.assign(actions.sequence.fields, SEQUENCE_RUN_ON);
}

module.exports = { extend };

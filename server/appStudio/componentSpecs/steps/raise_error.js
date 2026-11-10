// @typecheck strict
/**
 * Step kind `raise_error`: fails the action on purpose with the author's own message. It fails
 * like any step: an enclosing try catches it, otherwise the action stops with that message.
 */

'use strict';

module.exports = {
    kind: 'raise_error',
    since: 3,
    side: 'control',
    fields: {
        message: { type: 'binding', required: true, description: 'What went wrong, for the person: a static text or a formula (at most 500 characters are shown).' },
        code: { type: 'string', maxLen: 60, description: 'A short machine name for the failure, read as error.code by a catch ("raised" when left out).' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    summary: () => 'raise_error',
    description: 'Stops the action with an error message you choose. Without an enclosing try the action ends as failed and the person sees `message` as the error. Inside the `steps` of a try, its `catch` runs with error.message and error.code set. `message` is a binding: { kind: "static", value: "The order has no lines." } or a formula. `code` (optional) is a short machine name a catch reads as error.code ("raised" when left out). Use it in a condition to refuse input a later step cannot handle, before anything is written. Nothing that already ran is undone (put writes that belong together in a transaction).',
};

// @typecheck strict
/**
 * Step kind `try`: runs `steps`. When one fails without a handler of its own, `catch` runs
 * with the failure in scope and the action goes on. `finally` runs however the steps ended.
 * A container: `steps`, `catch` and `finally` are numbered in pre-order, in that order.
 * `errorScope` on `catch` tells the validator that `error` has a value in those steps.
 */

'use strict';

module.exports = {
    kind: 'try',
    since: 3,
    side: 'control',
    fields: {
        steps: { type: 'steps', required: true, description: 'The steps to attempt.' },
        catch: { type: 'steps', errorScope: true, description: 'Runs when a step in `steps` fails, with error.message, error.step, error.code and error.attempts in scope. Present (even empty): the failure is handled and the action goes on. Left out: the failure still ends the action after `finally`.' },
        finally: { type: 'steps', description: 'Always runs last: after `steps` succeeded, after `catch`, and before a return, break or continue leaves the try.' },
    },
    childSlots: [{ field: 'steps' }, { field: 'catch' }, { field: 'finally' }],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `try{…}${Array.isArray(s.catch) ? '!catch' : ''}${Array.isArray(s.finally) ? '+finally' : ''}`,
    description: 'Runs steps and, when one fails, runs catch instead of stopping. One handler for a whole group of steps: { kind: "try", steps: [...], catch: [{ kind: "toast", message: "Could not save", tone: "danger" }], finally: [{ kind: "set_variable", name: "busy", value: { kind: "static", value: false } }] }. `catch` decides what a failure does: with a catch (even an empty list, which carries on silently) the failure is handled and the action goes on after the try, without one the failure still ends the action once `finally` ran. `finally` always runs last, also when a return, break or continue leaves the try. A step keeps its own retry and onError: it is retried first, and a step whose own onError handled the failure does not reach catch. A failed transaction (nothing saved) and a raise_error are caught like any other failure. In catch, read error.message, error.step and error.code. A failure inside catch or finally ends the action unless another try surrounds it. A declined confirm is not a failure: catch is skipped, finally still runs.',
};

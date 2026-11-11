// @typecheck strict
/**
 * Step kind `wait`: a short pause in the browser, at most LIMITS.MAX_CLIENT_WAIT_SECONDS. Only
 * the client form exists so far: every server-side execution form (background job, mailbox
 * hook, later triggers) refuses it, and app_run_action skips it like any browser step.
 */

'use strict';

const { LIMITS } = require('../limits');

module.exports = {
    kind: 'wait',
    since: 3,
    side: 'client',
    fields: {
        seconds: { type: 'int', required: true, min: 1, max: LIMITS.MAX_CLIENT_WAIT_SECONDS, description: `How long to pause, in whole seconds (1 to ${LIMITS.MAX_CLIENT_WAIT_SECONDS}).` },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `wait(${String(s.seconds ?? '?')}s)`,
    description: `Pauses the sequence for a few seconds in the browser. { kind: "wait", seconds: 3 } holds the next step back for three seconds (1 to ${LIMITS.MAX_CLIENT_WAIT_SECONDS}). Use it to leave a message on screen before navigate moves on, or to give a slow outside system a moment before a refresh reads it again. The person can keep using the screen meanwhile, and leaving the app ends the wait and the rest of the sequence. It is not a scheduler: anything longer belongs in an automation. A background action cannot hold a wait yet (it is refused there), and a mailbox hook does not run it.`,
};

// @typecheck strict
/**
 * Step kind `wait`: holds the next step back.
 *
 *   - In the browser (a click, a public page): a short pause of at most
 *     LIMITS.MAX_CLIENT_WAIT_SECONDS, as it always was.
 *   - In a run on the server (`runOn: 'server'` or `background: true`): up to a minute is held in
 *     the run; anything longer, and every `until`, puts the run on hold (runPause.mts) and the
 *     wake job continues it then (appStudio/durableWait.mts). Bounded by STUDIO_APP_PAUSE_MAX_MS.
 *
 * The validator says where a long wait cannot be (validate/durableStepChecks.mts): in an action
 * the page walks, and inside a parallel branch. A mailbox hook does not run it, and
 * app_run_action skips it (a test never waits).
 */

'use strict';

const { LIMITS } = require('../limits');

/** The longest wait a definition may name, in seconds (30 days, the default STUDIO_APP_PAUSE_MAX_MS). */
const MAX_WAIT_SECONDS = 2_592_000;

module.exports = {
    kind: 'wait',
    since: 3,
    side: 'client',
    fields: {
        seconds: { type: 'int', min: 1, max: MAX_WAIT_SECONDS, description: `How long to pause, in whole seconds. In the browser 1 to ${LIMITS.MAX_CLIENT_WAIT_SECONDS}; in a run on the server up to ${MAX_WAIT_SECONDS} (30 days).` },
        until: { type: 'binding', description: 'Wait until this moment instead: a date-time (ISO text such as "2026-12-01T09:00:00Z", or epoch milliseconds). A moment that has passed does not wait. Only in a run on the server.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'refuse', unattended: 'run', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => (s.until !== undefined ? 'wait(until)' : `wait(${String(s.seconds ?? '?')}s)`),
    description: `Pauses the sequence. { kind: "wait", seconds: 3 } holds the next step back for three seconds. `
        + `In the browser a wait lasts 1 to ${LIMITS.MAX_CLIENT_WAIT_SECONDS} seconds: use it to leave a message on screen before navigate moves on, or to give a slow outside system a moment before a refresh reads it again. The person can keep using the screen meanwhile, and leaving the app ends the wait and the rest of the sequence. `
        + `A longer wait needs a run on the server (runOn: "server" or background: true on the sequence): there seconds may be up to ${MAX_WAIT_SECONDS} (30 days), or \`until\` names the moment, e.g. { kind: "wait", until: { kind: "formula", expr: "vars.remindAt" } }. The run is put on hold and goes on by itself at that time; nobody has to keep the page open. `
        + 'Not inside a parallel branch (only a wait the browser can hold fits there), and a mailbox hook does not run it. app_run_action and saved tests do not wait: they skip the step. Give exactly one of seconds and until.',
};

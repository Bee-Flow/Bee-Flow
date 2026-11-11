// @typecheck strict
/**
 * Step kind `while`: repeats its steps as long as a formula holds, at most maxIterations
 * rounds. A container: its `steps` are numbered in pre-order like a loop body. Not for the
 * mailbox hook (an arriving mail never loops).
 */

'use strict';

const { LIMITS } = require('../limits');

module.exports = {
    kind: 'while',
    since: 3,
    side: 'control',
    fields: {
        expr: { type: 'formula', required: true, description: 'Checked before every round. The steps run while it is true.' },
        steps: { type: 'steps', required: true, description: 'The steps of one round.' },
        maxIterations: { type: 'int', min: 1, max: LIMITS.MAX_ACTION_LOOP_ITERATIONS, description: 'The most rounds that run (1 to 200, 200 when left out). When it is reached the loop ends and the action goes on.' },
    },
    childSlots: [{ field: 'steps' }],
    retrySafe: true,
    // Like a loop: nothing loops on an arriving mail.
    policy: { click: 'browser', background: 'run', mailboxHook: 'refuse', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `${String(s.kind)}{…}`,
    description: 'Repeats its steps while a formula is true, at most maxIterations rounds. maxIterations is 1 to 200 (200 when left out). `expr` is checked before every round against the live scope, so the steps must change what it reads (set_variable, or a resultVar): { kind: "while", expr: "vars.page <= vars.pages", maxIterations: 20, steps: [...] }. There is no item or index: keep your own counter in a variable. Reaching maxIterations is not an error, the action simply goes on, so check the condition again afterwards when it matters. break leaves it early and continue starts the next round. For walking the rows of a list use loop. A send_email step may not sit inside it.',
};

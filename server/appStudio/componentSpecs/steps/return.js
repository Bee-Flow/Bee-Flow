// @typecheck strict
/**
 * Step kind `return`: ends the action it sits in, with an optional result. The walkers
 * (sequenceWalk.mts, the browser's actionRunner/controlFlow.ts) evaluate it themselves.
 */

'use strict';

module.exports = {
    kind: 'return',
    since: 3,
    side: 'control',
    fields: {
        value: { type: 'binding', description: 'The result of the action: a static value or a formula. Left out, the result stays what the last server step gave.' },
    },
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    summary: () => 'return',
    description: 'Ends the action here and hands back an optional value. The steps after it do not run and the action still counts as succeeded (its onSuccess effects apply). Inside an action run through call_action only that action ends: the caller goes on with its next step and reads `value` through the call\'s resultVar. A `finally` list of an enclosing try still runs first. Use it as an early exit inside a condition ("nothing to do") instead of nesting the rest of the action in the else branch.',
};

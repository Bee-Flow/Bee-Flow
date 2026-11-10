// @typecheck strict
/**
 * Step kind `continue`: skips the rest of the current round of the nearest enclosing loop or
 * while. The validator refuses it anywhere else (validate/controlFlowChecks.mts).
 */

'use strict';

module.exports = {
    kind: 'continue',
    since: 3,
    side: 'control',
    fields: {},
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    description: 'Skips the rest of this round of the nearest loop or while. The loop goes on with its next row (a while checks its expr again). Only valid inside the steps of a loop or while (a condition, switch or try in between is fine), never across a call_action. Use it to pass over rows that need no work: { kind: "condition", expr: "item.done", then: [{ kind: "continue" }] }.',
};

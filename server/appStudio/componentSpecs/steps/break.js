// @typecheck strict
/**
 * Step kind `break`: leaves the nearest enclosing loop or while. The validator refuses it
 * anywhere else (validate/controlFlowChecks.mts).
 */

'use strict';

module.exports = {
    kind: 'break',
    since: 3,
    side: 'control',
    fields: {},
    childSlots: [],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    description: 'Leaves the nearest enclosing loop or while at once. The rest of this round and all later rounds are skipped, and the action goes on with the step after the loop. Only valid inside the steps of a loop or while (a condition, switch or try in between is fine), never across a call_action. Put it in a condition: { kind: "condition", expr: "vars.found", then: [{ kind: "break" }] }.',
};

// @typecheck strict
/**
 * TEST FIXTURE, never shipped: a control kind that holds steps in two places (a plain list
 * and a list of entries that each hold steps). stepRegistry.test.js loads this directory to
 * prove a registry container is numbered, redacted and listed without touching a hand list.
 */

'use strict';

module.exports = {
    kind: 'zz_guarded',
    since: 3,
    side: 'control',
    fields: {
        expr: { type: 'formula', required: true },
        body: { type: 'steps', required: true },
        branches: { type: 'guardBranches' },
        note: { type: 'string', maxLen: 80 },
    },
    childSlots: [{ field: 'body' }, { field: 'branches', each: 'steps' }],
    retrySafe: true,
    policy: { click: 'browser', background: 'run', mailboxHook: 'run', unattended: 'refuse', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    writesVars: [{ field: 'note' }],
};

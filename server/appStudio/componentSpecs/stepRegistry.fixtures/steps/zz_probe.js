// @typecheck strict
/**
 * TEST FIXTURE, never shipped: a server kind with its executor in a file
 * (../handlers/zz_probe.mts), not retried, on the model budget, mockable in a dry run and
 * refused on a public page and in a background job.
 */

'use strict';

module.exports = {
    kind: 'zz_probe',
    since: 3,
    side: 'server',
    fields: {
        tableId: { type: 'string', required: true },
        input: { type: 'binding' },
        resultVar: { type: 'string', maxLen: 60 },
    },
    childSlots: [],
    retrySafe: false,
    policy: { click: 'step', background: 'refuse', mailboxHook: 'run', unattended: 'refuse', mcpRun: 'run', mcpDryRun: 'mock', public: 'refuse' },
    budget: 'ai',
    handler: 'file',
    writesRecords: true,
    noLoop: true,
    summary: (/** @type {Record<string, unknown>} */ step) => `zz_probe(${String(step.tableId)})`,
};

// @typecheck strict
/**
 * Step kind `parallel`: runs its branches side by side and goes on when all of them ended.
 * A container: the steps of every branch are numbered in pre-order, branch after branch
 * (`branches[k].steps`). Not for the mailbox hook (an arriving mail takes one path).
 * What a branch may hold and how the join works: shared/appDefinition/parallelRules.mjs.
 */

'use strict';

const { LIMITS } = require('../limits');

module.exports = {
    kind: 'parallel',
    since: 3,
    side: 'control',
    fields: {
        branches: { type: 'stepBranches', required: true, description: `The branches, 1 to ${LIMITS.MAX_PARALLEL_BRANCHES}: [{ steps: [...] }, { steps: [...] }]. Each branch is its own list of steps.` },
        failFast: { type: 'boolean', description: 'true: when one branch fails, the other branches stop before their next step. Left out or false: every branch runs to its end first.' },
    },
    childSlots: [{ field: 'branches', each: 'steps' }],
    retrySafe: true,
    // Like a loop: an arriving mail takes one path.
    policy: { click: 'browser', background: 'run', mailboxHook: 'refuse', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' },
    summary: (/** @type {Record<string, unknown>} */ s) => `parallel{${Array.isArray(s.branches) ? s.branches.length : 0}}`,
    description: `Runs several lists of steps side by side and goes on when all ended. Use it for work that does not depend on each other, such as two AI steps or reads of two tables: { kind: "parallel", branches: [{ steps: [{ kind: "ai_generate", ..., resultVar: "summary" }] }, { steps: [{ kind: "kb_query", ..., resultVar: "sources" }] }] }. 1 to ${LIMITS.MAX_PARALLEL_BRANCHES} branches. Every branch starts with the variables as they were before the step and does not see what another branch writes. After the last branch ended, the variables the branches wrote are all there for the next step, so give every branch its own resultVar or variable name: when two branches write the same name the later branch in the list wins, and the validator warns. A branch that fails ends the action after the other branches finished (failFast: true stops them before their next step, and a finally in them does not run). Put the parallel inside a try, or give the step in the branch its own onError, to carry on instead. Not allowed inside a branch, also not through call_action: navigate, confirm, open_modal, transaction, send_email and another parallel. A return directly in a branch is not allowed either (inside a called action it is fine), and a break or continue cannot leave a loop around the parallel. A dry run walks the branches one after another.`,
};

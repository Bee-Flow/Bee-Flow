// English GUI defaults — namespace "automation": every key whose part before the first "." is "automation".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Plan locks on routine steps (the enterprise split): the builder palette,
    // the lock chip on a step already on the canvas, and a refused activation.
    // agent-hub/src/components/automation/Builder/flow/planLockModel.ts,
    // agent-hub/src/components/automation/planRefusal.ts.
    'automation.plan.badge': 'Enterprise',
    'automation.plan.privacy_locked': 'Privacy Shield steps are part of the Enterprise plan. Steps that are already live keep running.',
    'automation.plan.privacy_disabled': 'Privacy Shield steps are switched off for your organisation. Ask an administrator to switch them on. Steps that are already live keep running.',
    'automation.plan.approval_locked': 'Approvals are part of the Enterprise plan. A routine with an approval step cannot go live without it.',
    'automation.plan.approval_disabled': 'Approvals are switched off for your organisation. Ask an administrator to switch them on.',
    'automation.plan.refused': 'This is not part of your organisation\'s plan.',
};

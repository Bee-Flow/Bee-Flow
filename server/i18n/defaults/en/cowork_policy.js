// @typecheck strict
// English GUI defaults — namespace "cowork_policy": every key whose part before the first "." is "cowork_policy".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "cowork_policy.apps": "Apps a plan may use while nobody watches",
    "cowork_policy.apps_hint": "App ids, separated by commas, such as outlook, datatables. Empty: every app.",
    "cowork_policy.audit": "Download the trail (CSV)",
    "cowork_policy.audit_hint": "Every change to a cowork in this organisation: who, what and when; never what the work says.",
    "cowork_policy.budget": "Monthly AI budget for all coworks",
    "cowork_policy.budget_hint": "In euros, counted from the 1st of the month over every cowork of the organisation. At the budget, coworks stop running until the next month; you are told once. Empty: no limit.",
    "cowork_policy.budget_invalid": "Fill in an amount above 0, or leave it empty.",
    "cowork_policy.ceiling": "How independent a cowork may be",
    "cowork_policy.ceiling.asks_before_sending": "At most: ask before anything leaves Bee Flow",
    "cowork_policy.ceiling.asks_everything": "At most: ask about everything",
    "cowork_policy.ceiling.on_its_own": "No ceiling: a cowork may run on its own",
    "cowork_policy.failed": "That did not save. Try again.",
    "cowork_policy.habits": "Let people switch on \"notice what I repeat\"",
    "cowork_policy.habits_desc": "Each person decides for themselves, and it is off until they switch it on. It keeps which apps a chat used and on which weekday, never what was asked. Switching this off stops it for everyone.",
    "cowork_policy.read_only": "Make every cowork read-only",
    "cowork_policy.read_only_desc": "Nothing runs, and nothing is created or changed, until you switch this off. Saved at once.",
    "cowork_policy.save_apps": "Save",
    "cowork_policy.save_budget": "Save budget",
};

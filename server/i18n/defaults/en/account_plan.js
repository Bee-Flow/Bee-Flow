// @typecheck strict
// English GUI defaults — namespace "account_plan": every key whose part before the first "." is "account_plan".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/account_plan.json. Settings > Account > Licence & usage for an account without an organisation: the plan card's billing line, the usage bar without a limit and the plan limits' labels.
module.exports = {
    "account_plan.free": "Free",
    "account_plan.free_no_billing": "No subscription, nothing is billed",
    "account_plan.monthly_billing": "Monthly billing",
    "account_plan.days_left_one": "{count} day left in this billing period",
    "account_plan.days_left": "{count} days left in this billing period",
    "account_plan.no_limit": "No limit",
    "account_plan.agents": "Agents",
    "account_plan.knowledge_sources": "Knowledge sources",
};

// @typecheck strict
// English GUI defaults — namespace "studio_apps_flow_parallel": every key whose part before the first "." is "studio_apps_flow_parallel".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_flow_parallel.json. The App Studio `parallel` step: its name in the step palette, the
// branch label on the flow canvas, the branch list in the step settings and what the running app says when a
// step cannot run inside a branch.
module.exports = {
    "studio_apps_flow_parallel.catalog.parallel_blurb": "Run several groups of steps at the same time and go on when all are done.",
    "studio_apps_flow_parallel.catalog.parallel_label": "Run side by side",
    "studio_apps_flow_parallel.runtime.not_in_parallel": "A {kind} step cannot run inside a branch of a parallel step.",
    "studio_apps_flow_parallel.runtime.too_many": "A parallel step holds at most {max} branches.",
    "studio_apps_flow_parallel.scope.branch": "Branch",
    "studio_apps_flow_parallel.settings.add_branch": "Add a branch",
    "studio_apps_flow_parallel.settings.branch_row": "Branch {n} ({count} steps)",
    "studio_apps_flow_parallel.settings.branches": "Branches",
    "studio_apps_flow_parallel.settings.fail_fast": "Stop the other branches when one fails",
    "studio_apps_flow_parallel.settings.fail_fast_hint": "Off: every branch runs to its end before the failure is reported. On: the other branches stop before their next step.",
    "studio_apps_flow_parallel.settings.help": "The branches run at the same time. Each one starts with the variables as they are before this step and does not see what another branch writes, so give every branch its own variable for its result.",
    "studio_apps_flow_parallel.settings.limit": "A step holds at most {max} branches.",
    "studio_apps_flow_parallel.settings.remove": "Remove",
    "studio_apps_flow_parallel.settings.remove_branch": "Remove branch {n}",
};

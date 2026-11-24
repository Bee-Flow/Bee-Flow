// @typecheck strict
// English GUI defaults — namespace "cowork_resolver": every key whose part before the first "." is "cowork_resolver".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "cowork_resolver.need.ai_failed": "The AI said its last run failed.",
    "cowork_resolver.need.incomplete": "Did not do its work last time: a step found nothing to work on.",
    "cowork_resolver.note.failed": "That did not work. Try again.",
    "cowork_resolver.note.fixed": "Fixed automatically: step '{step}' was reading the wrong field.",
    "cowork_resolver.note.undo": "Undo",
    "cowork_resolver.note.undoing": "Undoing…",
    "cowork_resolver.policy.auto_fix": "Let Cowork fix a broken reference by itself",
    "cowork_resolver.policy.auto_fix_desc": "When a step reads a list that is not there, Cowork may point it at the right one: only that reference changes, with exactly the same permissions, after a replay of the run proves it. The owner sees it and can undo it in one click. Saved at once.",
    "cowork_resolver.repair.reference": "Step '{step}' found nothing to work on. A fix is ready.",
    "cowork_resolver.status.incomplete": "Did not do its work",
};

// @typecheck strict
// English GUI defaults — namespace "cowork_wiring": every key whose part before the first "." is "cowork_wiring".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "cowork_wiring.failure.date": "'{step}' could not read the date from '{source}'.",
    "cowork_wiring.failure.date_alone": "'{step}' could not read a date.",
    "cowork_wiring.failure.date_missing": "'{step}' could not read the date: it reads from a step that is not in the plan.",
    "cowork_wiring.failure.step": "'{step}' did not work.",
    "cowork_wiring.failure.step_from": "'{step}' could not work with what '{source}' gave it.",
    "cowork_wiring.make.repairing": "Fixing what the try-out found…",
    "cowork_wiring.make.trying": "Trying the plan once, without changing or sending anything…",
    "cowork_wiring.note.fixed": "Fixed automatically: {changes}.",
    "cowork_wiring.note.reads": "'{step}' now reads from '{other}'",
    "cowork_wiring.note.waits": "'{step}' now waits for '{other}'",
    "cowork_wiring.repair.wiring": "'{step}' reads from a step that does not run before it. A fix is ready.",
    "cowork_wiring.tried.ai_many": "{count} AI steps wrote their answers",
    "cowork_wiring.tried.ai_one": "the AI wrote its answer",
    "cowork_wiring.tried.failed": "Tried, and it does not work yet. It cannot be approved until a try-out passes:",
    "cowork_wiring.tried.nothing": "it ran",
    "cowork_wiring.tried.passed": "Tried once: {what}. Nothing was changed or sent.",
    "cowork_wiring.tried.passed_rounds": "Tried {count} times until it worked: {what}. Nothing was changed or sent.",
    "cowork_wiring.tried.read": "'{step}' read its data",
    "cowork_wiring.tried.read_items": "'{step}' read {count} items",
    "cowork_wiring.tried.read_one": "'{step}' read 1 item",
    "cowork_wiring.tried.running": "A try-out is running.",
    "cowork_wiring.tried.stale": "The plan changed since its try-out. Try it again before you approve it.",
    "cowork_wiring.tried.untried": "Not tried yet, because it cannot run as it is:",
};

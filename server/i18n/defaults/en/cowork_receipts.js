// @typecheck strict
// English GUI defaults — namespace "cowork_receipts": every key whose part before the first "." is "cowork_receipts".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "cowork_receipts.download": "Download the receipts",
    "cowork_receipts.holds": "Every run has a receipt, and the chain of {count} holds.",
    "cowork_receipts.missing": "{count} finished runs have no receipt.",
    "cowork_receipts.problem.content": "Receipt {seq} was changed after it was issued.",
    "cowork_receipts.problem.gap": "Receipt {seq} is missing from the chain.",
    "cowork_receipts.problem.link": "Receipt {seq} does not follow the one before it.",
    "cowork_receipts.problem.signature": "Receipt {seq} does not carry a valid signature.",
    "cowork_receipts.run_signed": "Receipt {seq} · signed",
    "cowork_receipts.run_unsigned": "Receipt {seq} · not signed",
    "cowork_receipts.unsigned": "{count} were issued without a signature.",
};

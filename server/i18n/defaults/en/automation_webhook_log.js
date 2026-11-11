// @typecheck strict
// English GUI defaults — namespace "automation_webhook_log": every key whose part before the first "." is "automation_webhook_log".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/automation_webhook_log.json. The webhook rows of the automation builder: what a rotation leaves valid, and the delivery log.
module.exports = {
    "automation_webhook_log.empty": "No deliveries yet.",
    "automation_webhook_log.hash_title": "Start of the SHA-256 of the body",
    "automation_webhook_log.note": "The body of a delivery is never kept here: only its size and a fingerprint.",
    "automation_webhook_log.previous_secret_until": "The previous secret is accepted until {when}.",
    "automation_webhook_log.size": "{bytes} bytes",
    "automation_webhook_log.status.accepted": "Accepted",
    "automation_webhook_log.status.bad_signature": "Signature not accepted",
    "automation_webhook_log.status.inactive": "Automation not active",
    "automation_webhook_log.status.replay": "Nonce used before",
    "automation_webhook_log.status.stale_timestamp": "Timestamp outside the window",
    "automation_webhook_log.status.trigger_not_live": "Trigger not published yet",
    "automation_webhook_log.title": "Recent deliveries",
};

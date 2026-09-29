// English GUI defaults — namespace "notification": every key whose part before the first "." is "notification".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Trigger-bus failure escalation. The {provider}/{event}/{title}
    // placeholders are filled in by the runner — keep the {curly} markers
    // intact when translating.
    'notification.automation_subscription_failing.title': '⚠️ Trigger unreachable: {title}',
    'notification.automation_subscription_failing.body': 'Automation "{title}" trigger ({provider} {event}) keeps failing: {error}. Check your integration or re-activate the automation.',
    'notification.automation_paused_max_attempts.title': '⚠️ Automation failed: {title}',
    'notification.automation_paused_max_attempts.body': 'The automation could not complete after {attempts} attempts and was paused. Open it to inspect the last run.',
};

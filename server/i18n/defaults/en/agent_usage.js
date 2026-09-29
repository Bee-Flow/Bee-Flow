// English GUI defaults — namespace "agent_usage": every key whose part before the first "." is "agent_usage".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    'agent_usage.kind_task': 'Scheduled tasks',
    'agent_usage.kind_cowork': 'Cowork schedules',
    'agent_usage.kind_support': 'Support inboxes',
    'agent_usage.kind_automation': 'Routines',
    'agent_usage.kind_app': 'Apps',
    'agent_usage.kind_webpage': 'Webpages',
    'agent_usage.others_conversations': 'Conversations by other people',
    'agent_usage.others_conversations_unknown': 'Conversations by other people could not be counted.',
    'agent_usage.unchecked': 'Could not be checked: {kinds}',
    'agent_usage.unreadable': 'The check did not answer, so this list is not complete.',
};

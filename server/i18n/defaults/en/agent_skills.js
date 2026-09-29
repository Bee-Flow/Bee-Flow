// English GUI defaults — namespace "agent_skills": every key whose part before the first "." is "agent_skills".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── Agent detail → Skills tab (Track S2, 2026-09) ───────
    'agent_skills.always': 'applied to every message',
    'agent_skills.attach': 'Attach {name}',
    'agent_skills.attached_count': '{count} skills attached',
    'agent_skills.dynamic': 'only when the agent needs it',
    'agent_skills.edit': 'Edit skill',
    'agent_skills.err_save': 'Could not save the skill.',
    'agent_skills.help': 'A skill attached here applies to every conversation with this agent.',
    'agent_skills.loading': 'Loading skills…',
    'agent_skills.new': 'New skill',
    'agent_skills.no_match': 'No skills match your search',
    'agent_skills.no_match_help': 'Try a different search term.',
    'agent_skills.none': 'No skills yet',
    'agent_skills.none_help': 'Create one to get started.',
    'agent_skills.retry': 'retry',
    'agent_skills.search': 'Search skills…',
    'agent_skills.title': 'Attached skills',
};

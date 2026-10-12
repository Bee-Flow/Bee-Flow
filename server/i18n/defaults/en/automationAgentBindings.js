// English GUI defaults — namespace "automationAgentBindings": every key whose part before the first "." is "automationAgentBindings".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// "Who can call this": the agents an agent_call automation is linked to, in the agent trigger panel.
module.exports = {
    'automationAgentBindings.title': 'Who can call this',
    'automationAgentBindings.hint': 'Only the agents you link here can start this automation. Anyone who may chat with a linked agent can use it through that agent. It runs as the owner of this automation.',
    'automationAgentBindings.loading': 'Loading…',
    'automationAgentBindings.load_failed': 'The linked agents could not be read, so they are not shown. That is not the same as having none.',
    'automationAgentBindings.none_yet': 'Not linked to any agent yet. No agent can call this automation until you link one.',
    'automationAgentBindings.linked_list': 'Linked agents',
    'automationAgentBindings.deleted_agent': 'A deleted agent',
    'automationAgentBindings.other_agent': 'Another agent',
    'automationAgentBindings.other_agent_hint': 'You cannot edit this agent, so only someone who can edit it can unlink it.',
    'automationAgentBindings.inactive_hint': 'Linked, but the owner of this automation cannot use this agent (is it published?), so it cannot call it.',
    'automationAgentBindings.not_granted_hint': 'Linked, but this agent leaves this automation out of its list of automations, so it is never offered. Tick it in the agent\'s "Automations as a tool".',
    'automationAgentBindings.unlink': 'Unlink {name}',
    'automationAgentBindings.read_only': 'Only people who can edit this automation can link agents to it.',
    'automationAgentBindings.save_trigger_first': 'Set the trigger to "Agent tool" and save it first, then link agents.',
    'automationAgentBindings.candidates_failed': 'Your agents could not be read, so none can be added right now. Try again in a moment.',
    'automationAgentBindings.no_candidates': 'No more agents to link. You can link agents you can edit and the owner of this automation can use.',
    'automationAgentBindings.add_label': 'Link an agent',
    'automationAgentBindings.add_placeholder': 'Link an agent…',
    'automationAgentBindings.error.agent_not_linkable': 'You cannot link this automation to that agent. You need edit rights on the agent.',
    'automationAgentBindings.error.agent_owner_cannot_use': 'The owner of this automation cannot use that agent, so it could not call the automation. Publish the agent, or pick one the owner can use.',
    'automationAgentBindings.error.tool_name_taken': 'Another automation linked to that agent already uses this tool name. Rename the tool first.',
    'automationAgentBindings.error.not_agent_call': 'Set the trigger to "Agent tool" and save before linking agents.',
    'automationAgentBindings.error.forbidden': 'You need edit rights on this automation to link agents.',
    'automationAgentBindings.error.generic': 'The agents could not be saved. Try again.',
};

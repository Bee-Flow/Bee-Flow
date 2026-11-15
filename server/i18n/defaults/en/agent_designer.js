// @typecheck strict
// English GUI defaults — namespace "agent_designer": every key whose part before the first "." is "agent_designer".
// The legacy Agent Designer (admin dashboard > Agents) and the Agent Hub designer panel.
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "agent_designer.nav_identity": "Identity",
    "agent_designer.nav_knowledge": "Knowledge",
    "agent_designer.nav_integrations": "Integrations",
    "agent_designer.nav_behavior": "Behavior",
    "agent_designer.nav_share": "Share & embed",
    "agent_designer.editor_tab_general": "General",
    "agent_designer.editor_tab_knowledge": "Knowledge",
    "agent_designer.editor_tab_skills": "Skills",
    "agent_designer.edit_agent": "Edit agent",
    "agent_designer.saving": "Saving…",
    "agent_designer.save_changes": "Save changes",
    "agent_designer.save_reread_failed": "Could not read the latest version of this agent, so nothing was saved. Try again.",
    "agent_designer.empty_system": "Select a system agent in the list to edit it.",
    "agent_designer.publish_to_groups": "Publish to {count} groups",
    "agent_designer.tools_title": "Integrations",
    "agent_designer.tools_intro_admin": "Choose which integrations this agent may use. Listed are the integrations available to its organisation.",
    "agent_designer.tools_master": "Integrations and web search",
    "agent_designer.tools_master_on": "The agent may use the integrations switched on below.",
    "agent_designer.tools_master_off": "Off: the agent uses no integration and no web search, whatever is switched on below.",
    "agent_designer.tools_checking": "Checking which integrations this organisation has…",
    "agent_designer.tools_own_account": "Own account per person",
    "agent_designer.tools_own_account_hint": "Each person who uses this agent connects their own account or key.",
    "agent_designer.tools_none_admin": "This organisation has no integrations available. Integration status shows what is set up, Access what the organisation may use.",
    "agent_designer.tools_none_user": "Connect an account or add an API key in your Settings to use integrations here.",
    "agent_designer.share_title": "Share & embed",
    "agent_designer.share_intro": "Put this agent on a website: a public chat page, an iframe or a chat bubble. It works once the agent is published.",
    "agent_designer.share_save_first": "Save the agent first to get its embed code.",
};

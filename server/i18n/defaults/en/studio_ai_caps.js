// @typecheck strict
// English GUI defaults — namespace "studio_ai_caps": every key whose part before the first "." is "studio_ai_caps".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// The "What the AI can do" panel in App settings (App Studio inspector, AiCapabilitiesPanel.tsx).
module.exports = {
    "studio_ai_caps.title": "What the AI can do",
    "studio_ai_caps.intro": "The AI steps in this app run as you, the owner. They only reach what is listed here, and only when a step asks for it.",
    "studio_ai_caps.can_heading": "It can use",
    "studio_ai_caps.cannot_heading": "It cannot",
    "studio_ai_caps.status.always": "Always",
    "studio_ai_caps.status.per_step": "Per step",
    "studio_ai_caps.status.available": "Available",
    "studio_ai_caps.status.off_app": "Off for this app",
    "studio_ai_caps.status.off_workspace": "Off in your workspace",
    "studio_ai_caps.status.no_provider": "No search service on this server",
    "studio_ai_caps.status.no_browser": "No browser on this server",
    "studio_ai_caps.status.checking": "Checking…",
    "studio_ai_caps.status.unknown": "Could not check",
    "studio_ai_caps.app_data.label": "This app's tables and files",
    "studio_ai_caps.app_data.detail": "The records, uploads and documents a step points it at.",
    "studio_ai_caps.knowledge.label": "Knowledge bases",
    "studio_ai_caps.knowledge.detail": "Only the knowledge bases chosen in a step. Chosen now: {count}.",
    "studio_ai_caps.web_search.label": "Web search",
    "studio_ai_caps.web_search.detail": "Searches the web and reads public pages, in AI steps that ask for it. Steps that ask now: {count}. The search words go to the search service, so they can contain data from this app.",
    "studio_ai_caps.web_search.toggle": "Let the AI steps of this app search the web",
    "studio_ai_caps.web_search.builder_note": "Only you can switch this on: the AI that builds the app has no way to. Your organisation can turn it off at any time with the Web Search integration.",
    "studio_ai_caps.browsing.label": "Web browsing",
    "studio_ai_caps.browsing.detail": "Opens a real browser as you while a viewer watches. Browsing steps now: {count}. Set it up under AI browsing below.",
    "studio_ai_caps.automations.label": "Automations",
    "studio_ai_caps.automations.detail": "Automations this app starts: {count}. They use their own connections, such as mail, Nextcloud or a calendar.",
    "studio_ai_caps.cannot.connections": "Use your other connections (mail, Nextcloud, calendars, CRM) directly. Only through an automation step you add.",
    "studio_ai_caps.cannot.act_alone": "Send e-mail or change records on its own. Only the steps you place in an action do that.",
    "studio_ai_caps.cannot.settings": "Change the app or these settings. The AI that builds the app has no way to switch on web search or browsing either.",
    "studio_ai_caps.cannot.unattended_browse": "Browse in background jobs or mailbox hooks. Browsing only runs while someone watches.",
};

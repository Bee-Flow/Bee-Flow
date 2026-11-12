// @typecheck strict
// English GUI defaults — namespace "incognito": every key whose part before the first "." is "incognito".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "incognito.toggle_label": "Incognito chat",
    "incognito.toggle_hint_off": "Start an incognito chat: nothing is saved and no memory is used",
    "incognito.toggle_hint_on": "Incognito is on. Click to turn it off before you send the first message",
    "incognito.banner_title": "Incognito chat",
    "incognito.banner_body": "Not saved, no memory, and it ends when you leave this chat.",
    "incognito.banner_compliance": "Your organisation's compliance logs (such as the knowledge base query log) and usage counts still apply.",
    "incognito.attachments_off": "Attachments are off in an incognito chat: a file would have to be stored to be read.",
    "incognito.memory_locked": "Memory is off in an incognito chat: nothing is read or saved.",
    "incognito.error.no_attachments": "An incognito chat cannot take attachments. Remove the file, or start a normal chat.",
    "incognito.error.unsupported_mode": "This mode is not available in an incognito chat. Pick another model, or start a normal chat.",
    "incognito.error.conversation_id": "This incognito chat cannot continue. Start a new chat.",
};

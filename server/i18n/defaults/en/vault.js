// English GUI defaults — namespace "vault": every key whose part before the first "." is "vault".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Tokenization vault (user settings → Security).
    "vault.title": "Your placeholder vault",
    "vault.description": "When Privacy Shield hides a personal detail from the AI, it stores which placeholder stood for which value here. Keeping the list means the same person or company gets the same placeholder in every conversation. Only you can see this.",
    "vault.search_placeholder": "Search a value or placeholder…",
    "vault.count": "{{n}} stored",
    "vault.load_failed": "Could not load your vault. Please try again.",
    "vault.empty": "Nothing stored yet.",
    "vault.empty_search": "Nothing matches that search.",
    "vault.empty_hint": "Entries appear here once Privacy Shield hides a personal detail in one of your conversations.",
    "vault.col_placeholder": "Placeholder",
    "vault.col_value": "Stands for",
    "vault.col_used": "Used",
    "vault.col_last": "Last used",
    "vault.unreadable": "Cannot be opened — you can delete it",
    "vault.delete": "Forget this",
    "vault.delete_confirm": "Forget \"{{value}}\"?\n\nAny saved message that still shows {{token}} will keep showing the placeholder — this cannot be undone.",
    "vault.load_more": "Show more",
    "vault.clear": "Forget everything in this vault",
    "vault.clear_warning": "Forget all stored values? Placeholders already saved in your conversations will stay as placeholders — this cannot be undone.",
    "vault.clear_confirm": "Yes, forget everything",
    "vault.clearing": "Forgetting…",
};

// @typecheck strict
// English GUI defaults — namespace "platform_panels": every key whose part before the first "." is "platform_panels".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `npm run i18n:gen`.
// The whole-server Platform panels of the admin dashboard (Languages, Modules, Appearance)
// and the personal icon-pack choice in Settings > Appearance.
module.exports = {
    // Languages: the language new accounts start in (one value for the whole server).
    "platform_panels.new_user_language": "New users start in",
    "platform_panels.new_user_language_hint": "The language a new account starts in, for everyone on this server. People can change their own language afterwards.",
    // Languages: the AI translate toolbar.
    "platform_panels.translate_tier": "Model tier for AI translation",
    "platform_panels.email_variables": "Variables:",
    // Languages: the locale list.
    "platform_panels.locale_actions": "Actions for {name}",
    // Appearance > Look > Member access.
    "platform_panels.access_on": "People see a theme switcher in the sidebar and a section in their settings.",
    "platform_panels.access_off": "Everyone sees the theme for this server, whatever they picked on their own device.",
    // Appearance > Icon packs: the pack list.
    "platform_panels.icon_packs_in_use": "In use by you",
    "platform_panels.icon_packs_count": "{n} custom icons",
    "platform_panels.icon_packs_choose_hint": "Packs are yours. Pick the one you use in Settings > Appearance.",
    "platform_panels.icon_packs_load_failed": "Could not load the icon packs.",
    "platform_panels.icon_packs_create_failed": "Could not create the pack.",
    "platform_panels.icon_packs_export_failed": "Could not export the pack.",
    "platform_panels.icon_packs_import_failed": "Could not import the pack: the file is not valid JSON.",
    "platform_panels.icon_packs_delete_title": "Delete this icon pack?",
    "platform_panels.icon_packs_delete_body": "This cannot be undone.",
    // Settings > Appearance: the person's own icon pack.
    "platform_panels.icon_pack": "Icon pack",
    "platform_panels.icon_pack_hint": "Replaces the icons in the app. Only you see your choice.",
    "platform_panels.icon_pack_default": "Standard icons",
    "platform_panels.icon_pack_default_desc": "The icons Bee Flow comes with.",
};

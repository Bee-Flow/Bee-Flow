// English GUI defaults — namespace "visibility": every key whose part before the first "." is "visibility".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Studio shared patterns — VisibilityCapsule (Personal / Organisation / Groups)
    "visibility.personal": "Personal",
    "visibility.personal_desc": "Only you can access",
    "visibility.entire_org": "Entire organisation",
    "visibility.entire_org_desc": "All members can access",
    "visibility.groups": "Groups",
    "visibility.group_named": "Group {name}",
    "visibility.one_group": "1 group",
    "visibility.n_groups": "{count} groups",
    "visibility.names_and": "{head} and {last}",
    "visibility.title": "Publish to…",
    "visibility.choose_who": "Choose who can see this.",
    "visibility.or_specific_groups": "Or specific groups",
    "visibility.no_groups_available": "No groups in this organisation yet.",
    "visibility.embed_hint": "Web embed is on — manage it in Behavior.",
    "visibility.aria_label": "Visibility",
    "visibility.add_group": "Add group",
    "visibility.remove_group": "Remove {name}",
    "visibility.this_item": "this item",
    "visibility.confirm_title": "Share more widely?",
    "visibility.confirm_share": "Share",
    "visibility.confirm_keep": "Keep as is",
    "visibility.confirm_org": "Everyone in your organisation will be able to see and use “{name}”.",
    "visibility.confirm_groups": "Members of {groups} will be able to see and use “{name}”.",
    "visibility.last_group_hint": "Choose Personal to stop sharing",
    'visibility.groups_unreadable': 'The list of groups could not be read, so sharing with specific groups is not offered right now. That is not “this organisation has no groups”.',
    'visibility.groups_retry': 'Try again',
};

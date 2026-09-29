// English GUI defaults — namespace "shield_look": every key whose part before the first "." is "shield_look".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// Privacy Shield (round 3), "What we look for": the intro, how strict, the one-table matrix and its link cards.
// Plain English for non-technical admins. Setting names stay as they are elsewhere.
module.exports = {
    "shield_look.col_count": "{n} of {total}",
    "shield_look.col_detect_sub": "look for it · {n} of {total}",
    "shield_look.col_external": "Hold back · outside tools",
    "shield_look.col_external_locked": "{n} of {total} · Enterprise",
    "shield_look.col_external_none": "{n} of {total} — anything may leave",
    "shield_look.col_internal": "Hold back · own server",
    "shield_look.group_hidden": "{n} of {total} hidden",
    "shield_look.intro_body": "Anything found is hidden from the AI. This happens on your own server — nothing is sent elsewhere to be checked.",
    "shield_look.intro_title": "Before a message goes to the AI, Bee Flow reads it and looks for personal details.",
    "shield_look.left_with_tools": "{n} left with tools",
    "shield_look.left_with_tools_title": "{n} tool calls carried this kind in the last {days} days.",
    "shield_look.link_never": "{n} of your own. Matches are exact: \"Shell\" does not cover \"Shell Advies BV\".",
    "shield_look.link_never_public": "221 well-known companies · {n} of your own. Matches are exact: \"Shell\" does not cover \"Shell Advies BV\".",
    "shield_look.link_own_empty": "None yet — add project codes, customer numbers and more.",
    "shield_look.matrix_hint": "{n} kinds · one row each",
    "shield_look.public_orgs_note": "221 well-known companies are never hidden",
    "shield_look.strict_advanced_show": "Advanced: exact percentage",
    "shield_look.strict_high": "High",
    "shield_look.strict_low": "Low",
    "shield_look.strict_scale_high": "hides more, also ordinary words →",
    "shield_look.strict_scale_low": "← misses more, fewer interruptions",
    "shield_look.strict_title": "How strict",
};

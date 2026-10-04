// English GUI defaults — namespace "shield_checks": every key whose part before the first "." is "shield_checks".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// Privacy Shield (round 3), "When we find something" + "Leaving your org": the flow card and the two check cards.
// Plain English for non-technical admins. Setting names stay as they are elsewhere.
module.exports = {
    // The path a message takes, drawn above the two cards.
    'shield_checks.flow_label': 'How a message is checked',
    'shield_checks.flow_look': 'Look for personal data',
    'shield_checks.flow_kinds': '{n} kinds · on your server',
    'shield_checks.flow_every': 'every message, always',
    'shield_checks.flow_unlicensed': 'not in your plan · stopped instead',
    'shield_checks.flow_inside': 'AI on your server',
    'shield_checks.flow_done': 'done',
    'shield_checks.flow_outside': '② Outside AI: last check',
    'shield_checks.flow_off': 'off',
    'shield_checks.flow_on': 'on',
    'shield_checks.flow_tools_skip': 'Tool calls skip ① and ②',
    'shield_checks.flow_tools_follow': 'They follow the tool columns in the matrix.',

    // Card 1: on every message.
    'shield_checks.every_title': 'On every message',
    'shield_checks.every_sub': 'always on · runs for every AI, inside or outside',
    'shield_checks.action_heading': 'When we find personal data',
    'shield_checks.tokenize_desc_lead': 'The AI sees',
    'shield_checks.tokenize_desc_example': 'email_1',
    'shield_checks.tokenize_desc_tail': 'instead of the address. Bee Flow puts the real value back in the answer.',
    'shield_checks.raw_payload_desc': 'Adds the original, the version the AI got and the placeholders to "How I got this answer".',
    'shield_checks.raw_payload_warn': 'Anyone who can open the conversation can reveal the real values.',
    'shield_checks.scan_kbs_desc': 'Personal data is replaced before it is stored. This can\'t be undone later: the stored text is the checked text.',
    'shield_checks.automations_desc': 'Automations run on their own with nobody watching. Their data and AI steps are checked the same way as chat.',

    // Card 2: before it leaves your organisation.
    'shield_checks.leaving_title': 'Before it leaves your organisation',
    'shield_checks.leaving_sub': 'only for an AI outside your organisation · the only step where people decide',
    'shield_checks.dlp_desc': 'Just before a message goes to an outside AI, it is checked once more for personal data and handled the way you choose.',
    'shield_checks.eu_desc_lead': 'Chats only go to AI models hosted in the EU (set up under AI Config → Chat Models). Covers',
    'shield_checks.eu_desc_bold': 'models only',
    'shield_checks.eu_desc_tail': '— connected apps such as Gmail follow the tool columns.',
    'shield_checks.search_upload_desc': 'So nothing from an attached document ends up in a search box.',
    'shield_checks.integ_monitor_desc': 'Every connected-app call is always logged. This also checks its content, so the reports can show what kind of data left.',

    // Card 2's footer: tool calls go around both checks.
    'shield_checks.tools_gap_count': '{n} tool calls carried personal data in the last {days} days.',
    'shield_checks.tools_gap_count_one': '1 tool call carried personal data in the last {days} days.',
    'shield_checks.tools_gap_after_count': 'Steps ① and ② do not change that — hold kinds back in the',
    'shield_checks.tools_gap_no_count': 'Steps ① and ② do not cover tool calls — hold kinds back in the',
    'shield_checks.tools_gap_link': 'tool columns of the matrix',
};

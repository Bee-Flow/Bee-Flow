// English GUI defaults — namespace "templates": every key whose part before the first "." is "templates".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── Templates ────────────────────────────────────────────────
    'templates.title': 'Templates',
    'templates.new_template': 'New Template',
    'templates.fill_template': 'Fill Template',
    'templates.download': 'Download',
    // Hardcoded literals converted (2026-10)
    'templates.detecting_parameters': 'Detecting parameters...',
    'templates.parameter_count': '{count} parameter',
    'templates.parameter_count_plural': '{count} parameters',
    'templates.tab_chat': 'Chat',
    'templates.tab_settings_knowledge': 'Settings & Knowledge',
    'templates.parameters': 'Parameters',
    'templates.analyzing_document': 'AI is analyzing the document and detecting parameters...',
    'templates.no_parameters': 'No parameters detected in this template',
    'templates.meeting_notes_context': 'Meeting Notes Context',
    'templates.notes_selected': '{count} selected',
    'templates.search_meeting_notes': 'Search meeting notes…',
    'templates.custom_instructions': 'Custom Instructions',
    'templates.custom_instructions_hint': 'Add extra context or rules for the AI when filling this template.',
    'templates.custom_instructions_placeholder': 'e.g. \'Always use formal Dutch language\', \'Company address is ...\', \'Use metric units\'',
    'templates.processing_title': 'AI is processing your template...',
    'templates.processing_text': 'Detecting parameters, generating instructions, and building knowledge base. This may take up to a minute.',
    'templates.fill_empty_title': 'Fill this template with AI',
    'templates.fill_empty_text': 'Describe what the document should contain. The AI will help you fill in all the parameters.',
    'templates.word_templates': 'Word Templates',
    'templates.upload_hint_before': 'Upload .docx templates with',
    'templates.upload_hint_after': 'for AI to fill',
    'templates.search_templates': 'Search templates...',
    'templates.upload_template': 'Upload Template',
    'templates.skip_ai_detection': 'Skip AI detection',
    'templates.upload_first': 'Upload Your First Template',
    'templates.more_parameters': '+{count} more',
    'templates.fill_with_ai': 'Fill with AI',
    'templates.rename': 'Rename',
};

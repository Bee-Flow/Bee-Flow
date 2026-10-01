// English GUI defaults — namespace "mapping": every key whose part before the first "." is "mapping".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// The data-mapping screens (the source panel, and from M4 on the value slots). One writer:
// the mapping milestones; other branches add their own namespace.
module.exports = {
    // Source panel ("Comes in"): one row per value an earlier step hands over.
    'mapping.source.from_text': 'read from text',
    'mapping.source.from_text_title': 'Read from the text this field holds. To use one of these values for now, use the whole field.',
    'mapping.source.open': 'Show what is inside {label}',
    'mapping.source.close': 'Hide what is inside {label}',
    'mapping.source.unconfirmed': 'Not in the last run',
};

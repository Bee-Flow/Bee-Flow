// English GUI defaults — namespace "mapping": every key whose part before the first "." is "mapping".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// The data-mapping screens (the source panel, and from M4 on the value slots). One writer:
// the mapping milestones; other branches add their own namespace.
module.exports = {
    // ── The v2 data mapping (picks, composed texts, per-item repeat) ──────
    // One writer: the automation data-mapping work. The run warnings come
    // first: what a run noticed about the values it was given (a value that
    // was empty, a list that went into a field for one value), listed on the
    // run so a green run with an empty field says why.
    'mapping.run_warnings_title': 'This run finished with {n} warning(s)',
    'mapping.run_warnings_show': 'Show',
    'mapping.run_warnings_hide': 'Hide',
    'mapping.run_warnings_hint': 'The run carried on. A field may have been empty, or held something other than you expected.',
    // One sentence per run warning code (server runWarnings.js; the run row
    // stores { code, params, text }). The params are paths, labels, input
    // names and step ids, never a value from the run. {name} is the label
    // in quotes, else the path.
    'mapping.run_warning.on_input': 'input "{input}": {warning}',
    'mapping.run_warning.a_value': 'a mapped value',
    'mapping.run_warning.template_missing': '{placeholder} resolved to nothing',
    'mapping.run_warning.ref_missing': '{path} resolved to nothing',
    'mapping.run_warning.expr_missing': 'expression "{expr}" resolved to nothing',
    'mapping.run_warning.expr_error': 'expression "{expr}" failed: {message}',
    'mapping.run_warning.mapping_invalid': 'a {kind} binding is not valid and gave no value',
    'mapping.run_warning.mapping_invalid_at': 'a {kind} binding on {path} is not valid and gave no value',
    'mapping.run_warning.pick_missing': '{name} was empty',
    'mapping.run_warning.pick_missing_required': '{name} was empty, and the step needs it',
    'mapping.run_warning.pick_many_for_one': '{name} held {count} values; only the first was used',
    'mapping.run_warning.pick_holes_dropped': '{name}: {count} item(s) without this field were left out',
    'mapping.run_warning.pick_parse_failed': '{name} could not be read as a {as}',
    'mapping.run_warning.as_number': 'number',
    'mapping.run_warning.as_date': 'date',
    'mapping.run_warning.as_yesno': 'yes or no',
    'mapping.run_warning.pick_each_outside_repeat': '{name} reads the current item, but this step does not repeat over that list',
    'mapping.run_warning.branch_no_edge': '{stepType} {step} routed to "{branch}" but no edge carries that branch — downstream steps did not run',
    'mapping.run_warning.branch_replayed_unrecorded': '{stepType} {step} was replayed without a recorded branch — nothing downstream of it ran',
    'mapping.run_warning.guard_unwired': 'guard {step} found personal data but nothing is wired to its "personal data" branch — no alert was sent',
    'mapping.run_warning.app_effect_ignored': 'return_to_app {step}: ignored "{field}" — {reason}',
    'mapping.run_warning.more': '…and {count} more warning(s)',
    // Source panel ("Comes in"): one row per value an earlier step hands over.
    'mapping.source.from_text': 'read from text',
    'mapping.source.from_text_title': 'Read from the text this field holds. To use one of these values for now, use the whole field.',
    'mapping.source.open': 'Show what is inside {label}',
    'mapping.source.close': 'Hide what is inside {label}',
    'mapping.source.unconfirmed': 'Not in the last run',
};

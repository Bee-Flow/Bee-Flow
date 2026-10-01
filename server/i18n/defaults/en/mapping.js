// English GUI defaults — namespace "mapping": every key whose part before the first "." is "mapping".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
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

    // M6: per-item repeat
    // "Run this step separately for each…" under a step's Advanced section
    // (StepRepeatSection), the one sentence in the step header while it is on
    // (RepeatNotice), and the list picker of a loop and the older per-item
    // setting (LoopOverPicker). {list} is a list in the author's words
    // ("Orders from Get orders"), never a path.
    'mapping.repeat.toggle': 'Run this step separately for each…',
    'mapping.repeat.for_each_in': 'Run for each item in…',
    'mapping.repeat.lists_heading': 'Lists you can repeat over',
    'mapping.repeat.no_lists': 'No earlier step hands this step a list yet.',
    'mapping.repeat.no_lists_formula': 'No earlier list found. Enter one under Formula.',
    'mapping.repeat.list_from_step': '{list} from {step}',
    'mapping.repeat.list_from_trigger': '{list} from the trigger',
    'mapping.repeat.list_of_item': '{list} of the current item',
    'mapping.repeat.a_list': 'a list',
    'mapping.repeat.everything': 'everything',
    'mapping.repeat.n_items': '{count} items',
    'mapping.repeat.n_times': '{count}×',
    'mapping.repeat.max': 'At most',
    'mapping.repeat.max_hint': 'Items per run, 1 to 1000. The rest is skipped and the run says so.',
    'mapping.repeat.preview_list': 'Each item in {list}, one run per item.',
    'mapping.repeat.preview_one': '1 value will read the current item.',
    'mapping.repeat.preview_many': '{n} values will read the current item.',
    'mapping.repeat.preview_none': 'No value reads the current item yet, so every run would do the same thing. Pick values from that list once this is on.',
    'mapping.repeat.apply': 'Turn on',
    'mapping.repeat.cancel': 'Cancel',
    'mapping.repeat.notice': 'Runs separately for each item in {list} ({count}×).',
    'mapping.repeat.notice_no_count': 'Runs separately for each item in {list}.',
    'mapping.repeat.notice_change': 'Change',
    'mapping.repeat.legacy_note': 'Set up the older way. It keeps working as it is.',
    'mapping.repeat.runs_n_times': 'This step will run {count} times, once for each item.',
    'mapping.repeat.item_name': 'Name each item',
    'mapping.repeat.item_name_hint': 'What each item is called in the values that read it. Renaming it updates them.',
    'mapping.repeat.item_name_invalid': 'A name uses letters, digits and _ only, and does not start with a digit.',
    'mapping.repeat.item_name_in_use': 'Another item is already called that here. Choose a different name.',
    'mapping.repeat.formula': 'Formula',
    'mapping.repeat.formula_list': 'The list, as a formula',
    'mapping.repeat.off_orphaned': 'Some texts or formulas still read the current item. They will be empty now: check them above.',
    'mapping.repeat.refused_already': 'This step already runs separately for each item in {list}.',
    'mapping.repeat.refused_legacy': 'This step already runs once per item the older way. Turn that off first.',
    'mapping.repeat.refused_invalid': 'That list cannot be repeated over.',
};

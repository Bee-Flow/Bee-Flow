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
    // Source panel ("Comes in"): one row per value an earlier step hands over.
    'mapping.source.from_text': 'read from text',
    'mapping.source.from_text_title': 'Read from the text this field holds. To use one of these values for now, use the whole field.',
    'mapping.source.open': 'Show what is inside {label}',
    'mapping.source.close': 'Hide what is inside {label}',
    'mapping.source.unconfirmed': 'Not in the last run',

    // M4a: value slot
    // The building blocks of a field that holds a value from an earlier
    // step (agent-hub Builder/valueSlot/): the chip, the one sentence under
    // it, the options that change how the value is used, and the question
    // where a clicked value should go. {label} is a value's name in words,
    // never a path; {count} is how many values a list holds.
    'mapping.slot.formula': 'Formula',
    'mapping.slot.stale': 'No longer available: {label}',
    'mapping.slot.repick': 'Pick again',
    'mapping.slot.remove': 'Remove {label}',
    'mapping.slot.open_options': 'Change how {label} is used',
    'mapping.slot.list_count': '{count} values',
    'mapping.slot.formula_title': 'Formula: {summary}',
    'mapping.slot.formula_gives': 'Gives:',
    'mapping.slot.change': 'Change',
    'mapping.slot.sentence.all_count': 'all {count}',
    'mapping.slot.sentence.all': 'all of them',
    'mapping.slot.sentence.text_lines': 'Comes as text: {all}, one per line.',
    'mapping.slot.sentence.text_comma': 'Comes as text: {all}, separated by commas.',
    'mapping.slot.sentence.text_bullets': 'Comes as text: {all}, as a bulleted list.',
    'mapping.slot.sentence.list_count': 'Comes as a list of {count}.',
    'mapping.slot.sentence.list': 'Comes as a list.',
    'mapping.slot.sentence.native': 'Comes as it is: {all}.',
    'mapping.slot.sentence.json': 'Comes as data: {all}.',
    'mapping.slot.sentence.first': 'Only the first.',
    'mapping.slot.sentence.last': 'Only the last.',
    'mapping.slot.sentence.first_of': 'Only the first of {count}.',
    'mapping.slot.sentence.last_of': 'Only the last of {count}.',
    'mapping.slot.sentence.count': 'The number of them.',
    'mapping.slot.sentence.count_n': 'The number of them ({count}).',
    'mapping.slot.sentence.each': 'One value per run, for each item.',
    'mapping.slot.sentence.column': 'Which column?',
    'mapping.slot.sentence.column_none': 'No column matches this field. Which column?',
    'mapping.slot.sentence.column_choose': 'Choose a column',
    'mapping.slot.options.title': 'How should {label} be used?',
    'mapping.slot.options.one': 'The value',
    'mapping.slot.options.all': 'All of them',
    'mapping.slot.options.all_lines': 'All, one per line',
    'mapping.slot.options.all_comma': 'All, with commas',
    'mapping.slot.options.all_bullets': 'All, as a bulleted list',
    'mapping.slot.options.first': 'Only the first',
    'mapping.slot.options.last': 'Only the last',
    'mapping.slot.options.count': 'The number',
    'mapping.slot.options.each': 'One per run, for each item',
    'mapping.slot.options.no_example': 'No example yet',
    'mapping.slot.options.empty_example': '(empty)',
    'mapping.slot.options.advanced': 'Advanced',
    'mapping.slot.options.formula_hint': 'Write a formula instead',
    'mapping.slot.options.row': 'Exactly this row',
    'mapping.slot.options.row_apply': 'Use row',
    'mapping.slot.options.repeat': 'Run this step separately for each item',
    'mapping.slot.target.title': 'Where should this go?',
    'mapping.slot.target.value': 'Put {label} in:',
    'mapping.slot.target.required': 'Required',
    'mapping.slot.target.none': 'Every field of this step is filled. Click a field first, then pick a value.',
    'mapping.slot.target.close': 'Close',
    'mapping.slot.label.of': '{field} of {parent}',
    'mapping.slot.label.of_all': '{field} of all {parent}',
    'mapping.slot.label.of_first': '{field} of the first {parent}',
    'mapping.slot.label.of_last': '{field} of the last {parent}',
    'mapping.slot.label.of_current': '{field} (of this {parent})',
    'mapping.slot.label.from': '{field} from {step}',
    'mapping.slot.label.from_first': 'The first {field} from {step}',
    'mapping.slot.label.from_last': 'The last {field} from {step}',
    'mapping.slot.label.from_current': '{field} (this one, from {step})',
    'mapping.slot.label.count_of': 'Number of {parent}',
    'mapping.slot.label.first': 'The first {parent}',
    'mapping.slot.label.last': 'The last {parent}',
    'mapping.slot.label.row': '{parent}, row {row}',
    'mapping.slot.label.output_of': 'Output of {step}',
    'mapping.slot.label.trigger': 'Incoming data',
    'mapping.slot.label.value': 'Value',
    // The value slot in a step's form (valueSlot/ValueSlot.tsx): typed, or
    // picked from "Comes in"; a second pick replaces the first, with Undo.
    'mapping.slot.placeholder': 'Type a value, or pick one from Comes in',
    'mapping.slot.date_placeholder': 'Type a date, or pick one from Comes in',
    'mapping.slot.use_data': 'Use data from a step',
    'mapping.slot.add_value': 'Add a value from a step',
    'mapping.slot.replaced': 'Replaced',
    'mapping.slot.undo': 'Undo',
    'mapping.slot.n_items': '{count} items',
    'mapping.slot.upgrade_note': 'This value is saved in the older format. Choosing an option saves it in the new one; each option shows what the field will get.',
    'mapping.slot.compose.text': 'Text',
    'mapping.slot.formula.from_text': '{value}, read from the text: {path}',
    'mapping.slot.advanced.formula': 'Formula',
    'mapping.slot.advanced.formula_for': 'Write {field} as a formula',
    'mapping.slot.advanced.this_value': 'this value',
    // The formula editor (mapping/BindingField.tsx) and its value picker.
    'mapping.formula.insert': 'Insert a value',
    'mapping.formula.insert_into': 'Insert into {field}',
    'mapping.picker.list_title': 'A list of {count} values',
    'mapping.picker.list_title_unknown': 'A list. Run the step above to see how many it holds.',
    // ── ComposeField: a text with values in it (M5b) ──────────────────
    // A prompt, a body, a subject: typed text with value pills. The example
    // under it shows what the run makes of the text.
    'mapping.compose.example': 'Example',
    'mapping.compose.list_lifts': 'This list goes in as JSON text: {preview}. Change anything in this text and it goes in as readable text instead.',
    'mapping.compose.name_title': 'Filled in with "{name}" when the step runs',
    'mapping.compose.repick': 'Pick another value',
    'mapping.compose.close_options': 'Close',
    'mapping.compose.insert_into': 'Insert into {label}',
    'mapping.compose.insert': 'Insert a value',
    // A typed formula next to a value it cannot be stored with (a whole list):
    // the field keeps its last saved text until one of the two is removed.
    'mapping.compose.unsaved_formula': 'The formula {formula} cannot be combined with the other values in this text. Remove one of them: until then, this change is not saved.',
};

// @typecheck strict
// English GUI defaults — namespace "studio_apps_di": every key whose part before the first "." is "studio_apps_di".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_di.json. App Studio table editor: lookup and rollup fields, a relation that holds several
// records, what deleting a linked record does, and the indexes of a table.
module.exports = {
    "studio_apps_di.type_lookup": "Lookup",
    "studio_apps_di.type_rollup": "Rollup",
    "studio_apps_di.choose": "Choose…",
    "studio_apps_di.many": "Holds several records",
    "studio_apps_di.many_hint": "Its value is a list of records. Filter on it with “contains”.",
    "studio_apps_di.on_delete": "When the linked record is deleted",
    "studio_apps_di.on_delete_default": "Default",
    "studio_apps_di.on_delete_restrict": "Refuse the delete",
    "studio_apps_di.on_delete_set_null": "Empty this field",
    "studio_apps_di.on_delete_cascade": "Delete these records too",
    "studio_apps_di.on_delete_hint": "The person deleting must be allowed to change or delete every linked record, or nothing is deleted.",
    "studio_apps_di.lookup_relation": "Through relation",
    "studio_apps_di.lookup_field": "Show field",
    "studio_apps_di.lookup_hint": "Read-only. Shows the field of the linked record, and stays empty when the viewer may not see that record.",
    "studio_apps_di.rollup_source": "Records that point here",
    "studio_apps_di.rollup_fn": "Calculate",
    "studio_apps_di.fn_count": "Count",
    "studio_apps_di.fn_sum": "Sum",
    "studio_apps_di.fn_min": "Lowest",
    "studio_apps_di.fn_max": "Highest",
    "studio_apps_di.fn_avg": "Average",
    "studio_apps_di.rollup_field": "Of field",
    "studio_apps_di.rollup_filter_kept": "Only records that match {n} filter rule(s) are counted; the rules are kept as they are.",
    "studio_apps_di.rollup_hint": "Read-only. Only the records the viewer may see are counted.",
    "studio_apps_di.indexes": "Indexes",
    "studio_apps_di.index_hint": "Makes filters and sorts on these columns fast on big tables. Adding or removing one never changes a row.",
    "studio_apps_di.index_n": "Index {n}",
    "studio_apps_di.add_index": "Add index",
    "studio_apps_di.remove_index": "Remove index",
};

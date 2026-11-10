// @typecheck strict
// English GUI defaults — namespace "studio_apps_dataread": every key whose part before the first "." is "studio_apps_dataread".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_dataread.json. App Studio data reads: the filter operators, measures and date groupings the
// editor offers beyond the first set, how filters combine, and the free search of a table binding.
module.exports = {
    'studio_apps_dataread.agg_p50': 'Median',
    'studio_apps_dataread.agg_p90': '90th percentile',
    'studio_apps_dataread.bucket_hour': 'By hour',
    'studio_apps_dataread.ignore_case': 'Ignore upper and lower case',
    'studio_apps_dataread.ignore_case_aria': 'Ignore upper and lower case for this filter',
    'studio_apps_dataread.match_all': 'Show a row when every filter matches',
    'studio_apps_dataread.match_any': 'Show a row when any filter matches',
    'studio_apps_dataread.match_label': 'How the filters combine',
    'studio_apps_dataread.op_ends_with': 'ends with',
    'studio_apps_dataread.op_not_contains': 'does not contain',
    'studio_apps_dataread.op_not_in': 'is not one of',
    'studio_apps_dataread.search_aria': 'Search in some columns',
    'studio_apps_dataread.search_desc': 'Shows the rows where any chosen column contains the text. An empty text shows every row.',
    'studio_apps_dataread.search_in': 'Look in these columns',
    'studio_apps_dataread.search_label': 'Search in some columns',
    'studio_apps_dataread.search_placeholder': 'e.g. vars.filters.q',
    'studio_apps_dataread.search_text': 'Text to search for',
};

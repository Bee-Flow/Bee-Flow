/**
 * The measure and date-bucket vocabularies of the Query Builder and the
 * aggregate binding panel (QueryBuilderParts re-exports them).
 */

// `label` is the English default, `labelKey` its translation key: render
// with t(x.labelKey, x.label).
export const AGGS = [
    { value: 'count', label: 'Count', labelKey: 'studio_apps_bi.query.agg_count' },
    { value: 'sum', label: 'Sum', labelKey: 'studio_apps_bi.query.agg_sum' },
    { value: 'avg', label: 'Average', labelKey: 'studio_apps_bi.query.agg_avg' },
    { value: 'min', label: 'Lowest', labelKey: 'studio_apps_bi.query.agg_min' },
    { value: 'max', label: 'Highest', labelKey: 'studio_apps_bi.query.agg_max' },
    { value: 'countDistinct', label: 'Distinct count', labelKey: 'studio_apps_aggregates.agg_count_distinct' },
];

export const DATE_BUCKETS = [
    { value: '', label: 'Exact', labelKey: 'studio_apps_bi.query.bucket_exact' },
    { value: 'day', label: 'By day', labelKey: 'studio_apps_bi.query.bucket_day' },
    { value: 'week', label: 'By week', labelKey: 'studio_apps_bi.query.bucket_week' },
    { value: 'month', label: 'By month', labelKey: 'studio_apps_bi.query.bucket_month' },
    { value: 'quarter', label: 'By quarter', labelKey: 'studio_apps_bi.query.bucket_quarter' },
    { value: 'year', label: 'By year', labelKey: 'studio_apps_bi.query.bucket_year' },
];

export const DATE_TYPES = new Set<string | undefined>(['date', 'datetime']);

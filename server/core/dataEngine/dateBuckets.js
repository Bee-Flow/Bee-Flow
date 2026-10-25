// @typecheck
/**
 * The SQL expression a date bucket folds a timestamp column onto (query
 * compiler, aggregate group-by). Pure: returns null for a bucket outside the
 * closed vocabulary, and the compiler turns that into its CompileError.
 */
'use strict';

/**
 * @param {string} col
 */
function dateBucketSql(col, bucket, dialect) {
    if (dialect === 'pg') {
        // ::timestamptz because the column may be DATE or TIMESTAMPTZ; both
        // cast cleanly and to_char then formats one type, not two.
        switch (bucket) {
            // Hour-of-day (00–23), not a timestamp — see the sqlite note below.
            case 'hour': return `to_char(${col}::timestamptz, 'HH24')`;
            case 'day': return `to_char(${col}::timestamptz, 'YYYY-MM-DD')`;
            case 'week': return `to_char(${col}::timestamptz, 'IYYY-"W"IW')`;
            case 'month': return `to_char(${col}::timestamptz, 'YYYY-MM')`;
            case 'quarter': return `to_char(${col}::timestamptz, 'YYYY-"Q"Q')`;
            case 'year': return `to_char(${col}::timestamptz, 'YYYY')`;
            default: return null;
        }
    }
    switch (bucket) {
        // Hour-of-day (00–23), not a timestamp: what a "busiest hours"
        // histogram folds every day of the range onto.
        case 'hour': return `strftime('%H', ${col})`;
        case 'day': return `strftime('%Y-%m-%d', ${col})`;
        case 'week': return `strftime('%Y-W%W', ${col})`;
        case 'month': return `strftime('%Y-%m', ${col})`;
        case 'quarter':
            return `(strftime('%Y', ${col}) || '-Q' || ((CAST(strftime('%m', ${col}) AS INTEGER) + 2) / 3))`;
        case 'year': return `strftime('%Y', ${col})`;
        default: return null;
    }
}

module.exports = { dateBucketSql };

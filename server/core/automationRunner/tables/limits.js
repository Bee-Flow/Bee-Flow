// @typecheck
/**
 * Caps for table data. Every one is an environment variable with a generous
 * default, and 0 means unlimited (the one exception is `minGroupFloor`, a
 * floor rather than a cap: 0 means no floor). They are read fresh on every
 * call so an operator can change one without a restart, and a test can set one
 * for a single case.
 */

'use strict';

/**
 * A whole number >= 0 from the environment; unset, empty or garbage gives `fallback`.
 * @param {string} name
 * @param {number} fallback
 * @param {Record<string, string|undefined>} [env]
 */
function capFromEnv(name, fallback, env = process.env) {
    const raw = env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** True when `cap` is on (> 0) and `value` is past it. */
function exceeds(value, cap) {
    return cap > 0 && value > cap;
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
function tableLimits(env = process.env) {
    const cap = (name, fallback) => capFromEnv(name, fallback, env);
    return {
        maxRows: cap('AUTOMATION_TABLE_MAX_ROWS', 1_000_000),
        maxBytes: cap('AUTOMATION_TABLE_MAX_BYTES', 512 * 1024 * 1024),
        maxColumns: cap('AUTOMATION_TABLE_MAX_COLUMNS', 1000),
        maxFileBytes: cap('AUTOMATION_TABLE_MAX_FILE_BYTES', 25 * 1024 * 1024),
        maxUncompressedBytes: cap('AUTOMATION_TABLE_MAX_UNCOMPRESSED_BYTES', 256 * 1024 * 1024),
        maxSheets: cap('AUTOMATION_TABLE_MAX_SHEETS', 50),
        previewRows: cap('AUTOMATION_TABLE_PREVIEW_ROWS', 20),
        inlineRows: cap('AUTOMATION_TABLE_INLINE_ROWS', 200),
        pageMaxRows: cap('AUTOMATION_TABLE_PAGE_MAX_ROWS', 500),
        maxTablesPerRun: cap('AUTOMATION_TABLE_MAX_TABLES_PER_RUN', 2000),
        maxOps: cap('AUTOMATION_TABLE_MAX_OPS', 50),
        maxGroups: cap('AUTOMATION_TABLE_MAX_GROUPS', 100_000),
        joinMaxRightRows: cap('AUTOMATION_TABLE_JOIN_MAX_RIGHT_ROWS', 500_000),
        pivotMaxColumns: cap('AUTOMATION_TABLE_PIVOT_MAX_COLUMNS', 200),
        maxSegments: cap('AUTOMATION_TABLE_MAX_SEGMENTS', 500),
        minGroupFloor: cap('AUTOMATION_TABLE_MIN_GROUP_FLOOR', 10),
        previewInputRows: cap('AUTOMATION_TABLE_PREVIEW_INPUT_ROWS', 1000),
        previewRpm: cap('AUTOMATION_TABLE_PREVIEW_RPM', 60),
        csvRpm: cap('AUTOMATION_TABLE_CSV_RPM', 30),
    };
}

module.exports = { capFromEnv, exceeds, tableLimits };

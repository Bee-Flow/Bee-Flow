'use strict';

/**
 * An on/off setting of an agent, read the way the row actually stores it.
 *
 * The four settings (`threads_enabled`, `copy_enabled`, `workspace_enabled`,
 * `embed_enabled`) are BOOLEAN columns, so Postgres hands them back as true or
 * false. The readers were written in the SQLite era and asked `x !== 0`, and
 * `false !== 0` is true: every one of them read an OFF setting as ON. A save
 * that did not mention the settings wrote them all back on — embed included,
 * which is a public chat page and switches the agent's memory off — and the
 * public embed offered a copy button its owner had turned off.
 *
 * The integer and text spellings are still recognised, for a row that came
 * through an export or an older snapshot. Anything else — NULL, a key the row
 * does not have — is not an answer, and reads as `fallback`: the column
 * default for a row, the current value for a snapshot being restored.
 *
 * routes/versions.js carries the same function for its restore.
 *
 * @param {unknown} value     the stored value
 * @param {boolean} fallback  what an unreadable value means
 * @returns {boolean}
 */
function storedFlag(value, fallback) {
    if (value === true || value === 1 || value === 't' || value === 'true') return true;
    if (value === false || value === 0 || value === 'f' || value === 'false') return false;
    return !!fallback;
}

/** The column defaults (stores/agent/initSchema.js), for a row that holds NULL. */
const FLAG_DEFAULTS = Object.freeze({
    threads_enabled: true,
    copy_enabled: true,
    workspace_enabled: false,
    embed_enabled: false,
});

module.exports = { storedFlag, FLAG_DEFAULTS };

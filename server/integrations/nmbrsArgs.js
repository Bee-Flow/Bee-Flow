// @typecheck strict
'use strict';

// Validation of the tool arguments shared by the NMBRS tools (ids, year, period).

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // entity-id args (NMBRS ids are numeric)

/** @param {unknown} value */
function validId(value) {
    return ID_RE.test(String(value || '').trim());
}

/** @param {string} value a year as the model sent it (parseInt also takes a number) */
function parseYear(value) {
    const y = parseInt(value, 10);
    return (Number.isInteger(y) && y >= 1900 && y <= 2100) ? y : null;
}

/** @param {string} value a period as the model sent it (parseInt also takes a number) */
function parsePeriod(value) {
    if (value === undefined || value === null || value === '') return null;
    const p = parseInt(value, 10);
    return (Number.isInteger(p) && p >= 1 && p <= 13) ? p : 'invalid';
}

module.exports = { validId, parseYear, parsePeriod };

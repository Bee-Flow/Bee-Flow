// @typecheck strict
'use strict';
/**
 * The one rule for a namespace file's name, shared by the English directory
 * (./en/index.js) and the Dutch one (./nl/index.js): a letter, then letters,
 * digits or underscores. Character codes, not a regex, so the rule reads the
 * same in every caller and has no backtracking.
 */

/**
 * @param {string} name
 * @returns {boolean}
 */
function isNamespaceName(name) {
    if (!name) return false;
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
        const digitOrUnderscore = (c >= 48 && c <= 57) || c === 95;
        if (!(letter || (i > 0 && digitOrUnderscore))) return false;
    }
    return true;
}

module.exports = { isNamespaceName };

// @typecheck strict
/**
 * App Studio catalog: the values a colorOrRole knob accepts, in one place for the canonicalizer,
 * the validator and the rule lists of styleRuleShape.js. A leaf: it requires nothing.
 *
 *   a role      one of the knob's roles (primary, neutral, success, …)
 *   a hex       #rrggbb
 *   a token     `token:<name>`, a colour the app defines in design.tokens (schema 3, package
 *               LK16). Whether the name exists is the validator's question (a warning), and a
 *               name that does not resolve paints nothing at run time.
 */

'use strict';

const HEX_DIGITS = '0123456789abcdefABCDEF';
const TOKEN_PREFIX = 'token:';
const TOKEN_NAME_MAX = 32;
const TOKEN_HEAD = 'abcdefghijklmnopqrstuvwxyz';
const TOKEN_TAIL = `${TOKEN_HEAD}0123456789-`;

/** @param {unknown} v @returns {v is string} */
function isHexColor(v) {
    if (typeof v !== 'string' || v.length !== 7 || v[0] !== '#') return false;
    for (const ch of v.slice(1)) if (!HEX_DIGITS.includes(ch)) return false;
    return true;
}

/**
 * A token name: a lower-case letter, then lower-case letters, digits or dashes, at most 32.
 * @param {unknown} v
 * @returns {v is string}
 */
function isTokenName(v) {
    if (typeof v !== 'string' || v.length < 1 || v.length > TOKEN_NAME_MAX || !TOKEN_HEAD.includes(v[0])) return false;
    for (const ch of v.slice(1)) if (!TOKEN_TAIL.includes(ch)) return false;
    return true;
}

/** @param {unknown} v @returns {v is string} */
function isTokenRef(v) {
    return typeof v === 'string' && v.startsWith(TOKEN_PREFIX) && isTokenName(v.slice(TOKEN_PREFIX.length));
}

/** The token name of a `token:<name>` value, or null. @param {unknown} v */
function tokenNameOf(v) {
    return isTokenRef(v) ? v.slice(TOKEN_PREFIX.length) : null;
}

/**
 * Is `v` a value a colorOrRole knob with these roles can store?
 * @param {unknown} v
 * @param {readonly string[]} roles
 * @returns {v is string}
 */
function isColorOrRoleValue(v, roles) {
    return typeof v === 'string' && (roles.includes(v) || isHexColor(v) || isTokenRef(v));
}

module.exports = { isHexColor, isTokenName, isTokenRef, tokenNameOf, isColorOrRoleValue, TOKEN_PREFIX, TOKEN_NAME_MAX };

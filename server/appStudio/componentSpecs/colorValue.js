// @typecheck strict
/**
 * App Studio catalog: the values a colorOrRole knob accepts, in one place for the canonicalizer,
 * the validator and the rule lists of styleRuleShape.js. A leaf: it requires nothing.
 *
 *   a role      one of the knob's roles (primary, neutral, success, …)
 *   a hex       #rrggbb
 */

'use strict';

const HEX_DIGITS = '0123456789abcdefABCDEF';

/** @param {unknown} v @returns {v is string} */
function isHexColor(v) {
    if (typeof v !== 'string' || v.length !== 7 || v[0] !== '#') return false;
    for (const ch of v.slice(1)) if (!HEX_DIGITS.includes(ch)) return false;
    return true;
}

/**
 * Is `v` a value a colorOrRole knob with these roles can store?
 * @param {unknown} v
 * @param {readonly string[]} roles
 * @returns {v is string}
 */
function isColorOrRoleValue(v, roles) {
    return typeof v === 'string' && (roles.includes(v) || isHexColor(v));
}

module.exports = { isHexColor, isColorOrRoleValue };

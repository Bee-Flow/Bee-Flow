// @typecheck
/**
 * The colours a project can give its people. The same hues as the project's
 * own colour (agent-hub's ProjectIdentityFields) plus violet: a person is
 * given one of these, never free text, so what reaches a style is always a
 * known hex.
 */

'use strict';

const MEMBER_COLORS = Object.freeze([
    '#3b82f6', // blue
    '#0ea5e9', // sky
    '#14b8a6', // teal
    '#22c55e', // green
    '#f59e0b', // amber
    '#f97316', // orange
    '#f43f5e', // rose
    '#ec4899', // pink
    '#8b5cf6', // violet
    '#64748b', // slate
]);

/** @param {unknown} value */
const isMemberColor = (value) => typeof value === 'string' && MEMBER_COLORS.includes(value.toLowerCase());

module.exports = { MEMBER_COLORS, isMemberColor };

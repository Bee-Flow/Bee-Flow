// @typecheck strict
'use strict';

/**
 * App Studio: the `tooltip` key of a component node (schema 3; its mark is keys/node/tooltip.js).
 * One place for the rule the canonicalizer keeps it by and the validator checks it with.
 */

const MAX_TOOLTIP_LEN = 200;

/**
 * The canonical tooltip: the text trimmed, or undefined to leave the key out (absent, empty, or
 * not a text). Longer text is cut to the limit.
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function cleanTooltip(raw) {
    if (typeof raw !== 'string') return undefined;
    const text = raw.trim();
    return text ? text.slice(0, MAX_TOOLTIP_LEN) : undefined;
}

module.exports = { MAX_TOOLTIP_LEN, cleanTooltip };

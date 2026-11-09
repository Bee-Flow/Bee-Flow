// @typecheck strict
'use strict';

/**
 * The name a test gets when nobody typed one: the question, cut at a word
 * boundary within `max` characters, with an ellipsis when it was shortened.
 * One overlong word is cut hard. The question itself is never shortened.
 * @param {string} question
 * @param {number} [max]
 */
function defaultName(question, max = 60) {
    const q = String(question || '').trim();
    if (q.length <= max) return q;
    const room = max - 1; // the ellipsis takes one character
    const head = q.slice(0, room);
    const cut = /\s/.test(q.charAt(room)) ? head.length : head.search(/\s\S*$/);
    const base = cut > 0 ? head.slice(0, cut) : head;
    return base.trimEnd() + '\u2026';
}

module.exports = { defaultName };

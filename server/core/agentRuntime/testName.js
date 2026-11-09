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
    // A plain scan, no regex over user text: the word ends where the next
    // character is whitespace, otherwise at the last whitespace inside `head`.
    const cut = isSpace(q.charAt(room)) ? head.length : lastSpaceIndex(head);
    const base = cut > 0 ? head.slice(0, cut) : head;
    return base.trimEnd() + '\u2026';
}

/** @param {string} ch */
function isSpace(ch) {
    return ch !== '' && ch.trim() === '';
}

/** @param {string} s */
function lastSpaceIndex(s) {
    for (let i = s.length - 1; i >= 0; i--) {
        if (isSpace(s.charAt(i))) return i;
    }
    return -1;
}

module.exports = { defaultName };

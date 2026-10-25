// @typecheck strict
/**
 * Log-safe stand-ins for user content. Personal data does not go into logs
 * (CLAUDE.md, privacy): a prompt, a file name, an e-mail address or a message
 * is replaced by what a reader of the log needs to follow one case — its
 * length, its kind and a short stable hash to tell two values apart — never
 * the text itself.
 *
 *   log.info(`parsing ${nameForLog(file.originalname)}`)   // "pdf file, 23 chars, #3f9a1c"
 *   log.info(`prompt ${textForLog(prompt)}`)                // "<512 chars, #a0b1c2>"
 *
 * The hash is a truncated sha256: enough to correlate log lines of the same
 * value within an incident, too short to look anything up.
 */

'use strict';

const { createHash } = require('crypto');

/** @param {unknown} value */
function shortHash(value) {
    return createHash('sha256').update(String(value)).digest('hex').slice(0, 6);
}

/**
 * A file name as its extension, length and hash.
 * @param {unknown} name
 * @returns {string}
 */
function nameForLog(name) {
    if (typeof name !== 'string' || !name) return '<no name>';
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase().slice(0, 8) : 'no-extension';
    return `${ext} file, ${name.length} chars, #${shortHash(name)}`;
}

/**
 * Free text (a prompt, a message, an e-mail address) as its length and hash.
 * @param {unknown} text
 * @returns {string}
 */
function textForLog(text) {
    if (text === undefined || text === null || text === '') return '<empty>';
    const s = String(text);
    return `<${s.length} chars, #${shortHash(s)}>`;
}

module.exports = { nameForLog, textForLog };

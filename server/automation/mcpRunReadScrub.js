// @typecheck
'use strict';
/**
 * Text scrubbing for the run reads (mcpRunReads.js): the error and file-name
 * forms that carry no run value by default. Pure, no I/O.
 */

/**
 * A credential-masked, length-capped line of an error message.
 * @param {number} chars
 */
function errorLine(text, chars) {
    if (typeof text !== 'string' || !text) return null;
    const { redactForPersistence } = require('../core/automationModel/runLogRedaction');
    const masked = redactForPersistence(text).value;
    return masked.length > chars ? `${masked.slice(0, chars)}…` : masked;
}

// Quoted spans ("x", 'x', `x`, curly quotes). An apostrophe inside a word (doesn't) is not a quote.
const QUOTED_RE = /(?<!\w)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’)/g;

/**
 * An error text with the parts that carry run values taken out, for the
 * default (protected) answer. The class travels separately and is the stable
 * signal; this is the best-effort sentence around it.
 *
 * A stop_error message is the author's template filled with run values by
 * construction, so only its length is shown. For any other error: quoted
 * spans, URLs, e-mail addresses, `{...}` objects and long numbers or
 * identifiers become placeholders; a credential marker stays. Free text with
 * no quote around it cannot be told from engine wording, so the raw text stays
 * behind `raw: true`.
 * @param {number} chars
 */
function valueFreeErrorLine(text, errorClass, chars) {
    if (typeof text !== 'string' || !text) return null;
    if (errorClass === 'stop_error') return `«message:${text.length}»`;
    const { redactForPersistence } = require('../core/automationModel/runLogRedaction');
    const scrubbed = redactForPersistence(text).value
        .replace(QUOTED_RE, (m) => `«string:${m.length - 2}»`)
        .replace(/\bhttps?:\/\/\S+/gi, '«url»')
        .replace(/[^\s@<>()«»]+@[^\s@<>()«»]+\.[^\s@<>()«»]+/g, '«email»')
        .replace(/\{[^{}]*\}/g, '«object»')
        .replace(/\b\d+(?:[.,]\d+)+\b|\b\d{4,}\b/g, '«number»')
        .replace(/\b(?=[\w-]*\d)[A-Za-z0-9_-]{16,}\b/g, '«id»');
    return scrubbed.length > chars ? `${scrubbed.slice(0, chars)}…` : scrubbed;
}

/** `«name:<chars>».ext`: a generated file name without the part that came from run data. */
function fileNameShape(name) {
    if (typeof name !== 'string' || !name) return null;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(name.slice(dot)) ? name.slice(dot).toLowerCase() : '';
    return `«name:${name.length - ext.length}»${ext}`;
}

/**
 * The tokens of a path as getRelativePath reads it, or null when it is not a
 * path. Used to see `[key="value"]` match segments before the path is applied.
 * @param {string} path
 */
function relativePathTokens(path) {
    const { parsePath } = require('../shared/expr/index.mjs');
    let p = String(path).trim();
    if (p === '' || p === '$') return [];
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    return parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`);
}

module.exports = { errorLine, valueFreeErrorLine, fileNameShape, relativePathTokens };

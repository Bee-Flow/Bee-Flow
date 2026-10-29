// @typecheck strict
/** Error text, role and body helpers for the Nextcloud Mail tools. */

const MAX_RAW_BODY = 400 * 1024; // the tool trims to 200 KB of text; never strip more than twice that

const { nextcloudHttpError } = require('./nextcloudHttpError');
const { stripHtmlToText } = require('../core/text/emailTextUtils');

/**
 * A failed Mail answer as a tool error. The shared mapping covers 401/403/404/5xx;
 * Mail adds 400 (a bad id) and 409 (the mailbox is still syncing).
 * @param {Response} res
 * @param {string} authError
 * @param {string} what
 */
async function mailError(res, authError, what) {
    if (res.status === 409) {
        return { error: `Mail ${what} conflicted (409): the mailbox may still be syncing. Wait a moment and retry.` };
    }
    if (res.status === 400) {
        const e = await nextcloudHttpError(res, { authError, what: `mail ${what}`, app: 'Mail' });
        return { error: `${e.error}${e.error.endsWith('.') ? '' : '.'} Check the accountId / mailboxId / messageId (take them from the Mail list tools).` };
    }
    return nextcloudHttpError(res, { authError, what: `mail ${what}`, app: 'Mail' });
}

/**
 * Mail reports the special-use role as a string, an array, or an empty array.
 * @param {{ specialRole?: string | string[], specialUse?: string | string[] }} m
 */
function normaliseRole(m) {
    const raw = m.specialRole ?? m.specialUse;
    const first = Array.isArray(raw) ? raw[0] : raw;
    return typeof first === 'string' && first ? first.replace(/^\\/, '').toLowerCase() : null;
}

/**
 * The plain-text body. Mail returns the HTML in `body` when the message has an
 * HTML part; the tool promises text, so use the plain part when there is one,
 * else strip the HTML (scripts and styles dropped, nothing is executed).
 * @param {{ body?: string, bodyPlain?: string, hasHtmlBody?: boolean }} m
 */
function mailBodyText(m) {
    // Cap first: the HTML is stripped with regexes, so its size bounds the work.
    const raw = String(m.body || '').slice(0, MAX_RAW_BODY);
    const html = !!m.hasHtmlBody || /<\/?[a-z][^<>]*>/i.test(raw);
    if (html) return m.bodyPlain || stripHtmlToText(raw);
    return m.body || m.bodyPlain || '';
}

const MAIL_API_BASE = '/index.php/apps/mail/api';
const MAX_BODY_BYTES = 200 * 1024;

/**
 * The body as JSON, or as the raw text when it is not JSON ('' when unreadable).
 * @param {{ text: () => Promise<string> }} res
 */
async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * @param {string} baseUrl
 * @param {string} path
 */
function api(baseUrl, path) {
    return `${baseUrl}${MAIL_API_BASE}${path}`;
}

const baseHeaders = {
    'Accept': 'application/json',
    'OCS-APIRequest': 'true', // harmless on non-OCS routes; required by some NC reverse proxies
};

/**
 * A message body cut to MAX_BODY_BYTES characters, marked when it was cut.
 * @param {string} text
 */
function trimBody(text) {
    if (!text) return text;
    if (text.length <= MAX_BODY_BYTES) return text;
    return text.slice(0, MAX_BODY_BYTES) + '\n\n... [truncated — body too large]';
}

module.exports = { mailError, normaliseRole, mailBodyText, MAX_BODY_BYTES, readJsonSafe, api, baseHeaders, trimBody };

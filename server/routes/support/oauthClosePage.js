// @typecheck
'use strict';

/**
 * The page the OAuth popup lands on after a mailbox connect (the per-mailbox
 * support inbox connect and the platform Service Email connect): a line of
 * text, then a script that tells the opener how it went and closes the popup.
 *
 * Every value written into the page is escaped for where it goes: HTML-escaped
 * in the text, and encoded for a script context in the inline <script>
 * (`<`, `>`, `&`, U+2028 and U+2029 as \u escapes, which a JS string literal
 * reads back as the same characters).
 */

const { esc } = require('../../core/seo/html');

const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

/** A JS string literal of `value` that is safe inside an inline <script>. */
function scriptString(value) {
    return JSON.stringify(value)
        .replace(SCRIPT_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function closePage({ type, title, okText }, ok, message) {
    const payload = JSON.stringify({ type, ok, message: message || '' });
    const text = ok ? okText : `Connection failed: ${String(message || '').slice(0, 200)}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#0f172a">
<p>${esc(text)}</p>
<script>try{window.opener&&window.opener.postMessage(${scriptString(payload)},'*');}catch (e) { console.debug("opener gone", e); }setTimeout(function(){window.close();},800);</script>
</body></html>`;
}

const SUPPORT_MAILBOX = { type: 'support-mailbox-oauth', title: 'Mailbox connected', okText: 'Mailbox connected. You can close this window.' };
const SERVICE_EMAIL = { type: 'service-email-oauth', title: 'Service email connected', okText: 'Service email connected. You can close this window.' };

const oauthClosePage = (ok, message) => closePage(SUPPORT_MAILBOX, ok, message);
const serviceEmailClosePage = (ok, message) => closePage(SERVICE_EMAIL, ok, message);

module.exports = { oauthClosePage, serviceEmailClosePage };

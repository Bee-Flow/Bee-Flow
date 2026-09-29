// @typecheck
/**
 * friendlyError — map raw extraction / ingestion errors to short, actionable
 * product language. The raw message is still logged by the caller; only the
 * friendly one is stored on `documents.status_reason` and shown to the user.
 *
 * Lifted from agents/notebooks/sourceIngestion.js (the notebook source stage
 * machine). K1b re-points that module here so there is one mapper.
 *
 * @param {Error|{message?:string}|string|null} e
 * @returns {string}
 */
function friendlyError(e) {
    const raw = typeof e === 'string' ? e : (e && e.message ? e.message : 'Unknown error');
    const m = String(raw);
    if (/timeout|timed out|ETIMEDOUT/i.test(m)) return 'Timed out while processing — try again.';
    if (/ENOTFOUND|ECONNREFUSED|getaddrinfo|fetch failed|network/i.test(m)) return 'Could not reach the URL — check the link and try again.';
    if (/\b(401|403|unauthor|forbidden)\b/i.test(m)) return 'The URL refused access (login or paywall).';
    if (/password|encrypted/i.test(m)) return 'This file looks password-protected — remove protection and re-upload.';
    if (/unsupported|cannot read|parse|extract/i.test(m)) return 'Could not read this file format.';
    return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

module.exports = { friendlyError };

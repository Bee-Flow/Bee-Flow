/**
 * Privacy Shield tokens on the DISPLAY read of a conversation (direct and
 * agent chats): the stored messages keep their `[person_1]` placeholders, and
 * a person who reopens the chat sees the real values again.
 *
 * The conversation's map is stored in `pii_token_map`, as an encryption
 * envelope when the org encrypts its Privacy Shield mappings. Only
 * core/dlp/dlpRunner.js can decrypt it (the owner's background key), and a
 * store may not call into core, so boot/ports.js registers that reader
 * here (`setTokenMapReader`).
 */

'use strict';

const log = require('../../telemetry/log');

/** @type {((conversationId: string) => Promise<Record<string, string>>) | null} */
let tokenMapReader = null;

/** core/dlp/dlpRunner.js hands over its decrypting reader. */
function setTokenMapReader(fn) {
    tokenMapReader = typeof fn === 'function' ? fn : null;
}

// Only `[bracketed]` keys are tokens. Anything else — an encryption envelope
// (`{ _bfenc, iv, tag, ct }`, the stored column of an org that encrypts its
// token maps) or a stray key — would be replaced inside ordinary words
// ("produ" + the ciphertext of `ct`), so it is dropped before restoring.
function _onlyTokens(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map) || map._bfenc) return null;
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(map)) if (/^\[[^\]]+\]$/.test(k) && typeof v === 'string') out[k] = v;
    return out;
}

/**
 * The conversation's token map for a display read: decrypted (the stored
 * column may be an encryption envelope) by core/dlp/dlpRunner.js's reader, which
 * boot/ports.js registers (getConversationTokenMapAsync: the owner's key, as the live turn
 * uses). Never throws; without a reader or a map the messages show their
 * placeholders, never ciphertext.
 * @param {{ id: string, pii_token_map?: unknown }} row
 */
async function _displayTokenMap(row) {
    if (!row || !row.pii_token_map || !tokenMapReader) return null;
    try {
        return await tokenMapReader(row.id);
    } catch (e) {
        log.warn(`[Conversations] token map of ${row.id} could not be read for display: ${e.message}`);
        return null;
    }
}

// Replace [email_N] / [phone_N] etc. tokens with the real values stored in
// the per-message tokenMap. Idempotent — messages without a tokenMap pass
// through unchanged. Only used on the UI-display read path; the LLM
// history loader passes restore=false so Claude keeps seeing tokens.
// Lazy-require inside the function: same circular-dep reason as
// piiDetection.js→aiAgent — capturing a destructure at module load
// can grab a stale snapshot of the cycle's partial exports.
function _restoreTokensInMessages(messages, convTokenMap = null) {
    if (!Array.isArray(messages)) return messages;
    const restoreTokens = require('../../core/privacy/piiDetection/tokenRestore').restoreTokens;
    if (typeof restoreTokens !== 'function') return messages;
    convTokenMap = _onlyTokens(convTokenMap);
    const convMapHasEntries = !!convTokenMap && Object.keys(convTokenMap).length > 0;
    return messages.map(m => {
        if (!m || typeof m.content !== 'string') return m;
        // User messages: use the per-message tokenMap (existing behaviour).
        // Each user turn captured the message-level tokens at the moment it
        // was tokenised — that's a stable, self-contained mapping.
        const userMap = m.role === 'user' ? _onlyTokens(m.tokenMap) : null;
        if (userMap && Object.keys(userMap).length > 0) {
            try {
                return { ...m, content: restoreTokens(m.content, userMap) };
            } catch (e) { /* fall through with original */ }
        }
        // Assistant messages: use the conversation-level token map. Assistant
        // tokens come from attachment scans + cross-turn message PII and are
        // not stashed per-message. Without this branch, an assistant response
        // referencing `[person_N]` would be displayed as raw placeholders on
        // a conversation reload.
        if (m.role === 'assistant' && convMapHasEntries) {
            try {
                return { ...m, content: restoreTokens(m.content, convTokenMap) };
            } catch (e) { /* fall through with original */ }
        }
        return m;
    });
}

module.exports = { setTokenMapReader, _restoreTokensInMessages, _displayTokenMap, _onlyTokens };

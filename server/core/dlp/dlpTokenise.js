// @typecheck
const { tokenizeText } = require('../privacy/piiDetection');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const log = require('../../telemetry/log');
const { _resolveOwner, _hydrateFromDb, getConversationTokenMap } = require('./dlpTokenMaps');

/**
 * Normalise findings to a single shape:
 *   { category, label, offset, length, text, source, severity }
 *
 * An org's own data type keeps the shape its old custom-term findings had
 * (`source: 'custom'`, severity medium); its category is the type's id, which
 * is what the tokenizer turns into the admin's placeholder.
 */
function _normalisePiiEntities(entities) {
    if (!Array.isArray(entities)) return [];
    return entities.map(e => {
        const custom = isCustomTypeId(e.category);
        return {
            category: e.category || 'PII',
            label: e.label || e.category || 'PII',
            offset: typeof e.offset === 'number' ? e.offset : 0,
            length: e.length || (e.text ? e.text.length : 0),
            text: e.text || '',
            source: custom ? 'custom' : 'pii',
            severity: custom ? 'medium' : 'high',
            confidence: e.confidence,
        };
    });
}

/**
 * Build a tokenised version of `text` for a list of normalised findings.
 * Returns { tokenizedText, tokenMap, summary } where summary is a compact
 * `{ category → count }` for logging and the UI.
 */
async function _tokeniseAll(text, findings, conversationId = null, { ephemeral = false } = {}) {
    // Pass the conversation's accumulated token map so counters continue across
    // turns and repeated values reuse their existing tokens. Without this,
    // turn 2's [email_1] would silently overwrite turn 1's mapping in the
    // merged conv map. Hydrate first: after a restart or an idle eviction the
    // in-process map is empty and the counters would restart at 1.
    if (conversationId && !ephemeral) await _hydrateFromDb(conversationId);
    const existing = conversationId ? getConversationTokenMap(conversationId) : null;

    // Union with the user's tokenization vault, so a value keeps the same token
    // across every conversation they have. The precedence rules live in the
    // store (buildSeed) because five other call sites need exactly the same
    // ones — a second copy here is how the two would drift apart.
    // An ephemeral scope has no conversation row, so it has no owner to look up.
    const userId = ephemeral ? null : await _vaultUserFor(conversationId);
    const vault = require('../../stores/piiVaultStore');
    const { tokenMap: seeded, counterFloors } = await vault.buildSeed(userId, findings, existing);

    // `tokenizeText` from piiDetection expects entities with offset/length/category/text.
    // Our normalised findings already match that shape.
    const { tokenizedText, tokenMap, sweptEntities = [] } = tokenizeText(text, findings, seeded, { counterFloors });

    // Teach the vault what this turn used. Deliberately not awaited: a vault
    // write must never sit on the critical path of a chat turn, and the
    // conversation token map remains the authority for restoring THIS
    // conversation whether or not it lands.
    if (userId) {
        vault.recordTokens(userId, tokenMap)
            .catch(err => log.warn(`[DlpRunner] vault record failed: ${err.message}`));
    }

    // Count the mentions the tokenizer's name sweep replaced too (BFSF-269):
    // they were redacted, so a summary of the findings alone undercounts.
    const summary = [...findings, ...sweptEntities].reduce((acc, f) => {
        const key = f.label || f.category;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return { tokenizedText, tokenMap, summary };
}

/**
 * Which user's vault does this conversation belong to?
 *
 * Cached via _resolveOwner, and null-safe: a conversation id with no owner row
 * (a notebook-scoped map before its notebook exists) simply gets no vault.
 */
/**
 * Persist a token map to the owning user's vault. Fire-and-forget by design:
 * the conversation map is already updated and remains the authority for this
 * conversation, so a vault write must never delay or fail a chat turn.
 */
function _recordToVault(conversationId, tokenMap) {
    if (!conversationId || !tokenMap || Object.keys(tokenMap).length === 0) return;
    _vaultUserFor(conversationId)
        .then(userId => (userId
            ? require('../../stores/piiVaultStore').recordTokens(userId, tokenMap)
            : null))
        .catch(err => log.warn(`[DlpRunner] vault record failed for ${conversationId}: ${err.message}`));
}

async function _vaultUserFor(conversationId) {
    if (!conversationId) return null;
    try {
        const owner = await _resolveOwner(conversationId);
        return owner?.userId || null;
    } catch (_) {
        return null;
    }
}

/**
 * Extract the last user message's plain-text content from a messages array.
 */
function _extractLastUserText(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
            const text = m.content.find((/** @type {{ type: string; }} */ b) => b?.type === 'text');
            return text?.text || '';
        }
        return '';
    }
    return '';
}

module.exports = { _normalisePiiEntities, _tokeniseAll, _recordToVault, _extractLastUserText };

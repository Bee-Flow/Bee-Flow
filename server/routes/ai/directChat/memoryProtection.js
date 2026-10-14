/**
 * The memory block of a direct-chat turn, made safe to send.
 *
 * 1. The user's own account data (name, e-mail, organisation, role) goes in
 *    front. It is not a memory, so it goes in whatever the memory policy says
 *    and never counts in the "memories used" chip. First in the block: the
 *    tokeniser then folds a later "tom" in a memory onto the token of the
 *    full name.
 * 2. Defence in depth: stored memories can carry real values from earlier
 *    turns that would otherwise bypass this turn's tokeniser. With the Privacy
 *    Shield on they become reversible conversation tokens (labels on the first
 *    turn of a new chat, swapped later by applyMemorySwap); the account values
 *    are replaced without asking the detector (knownEntities).
 */
'use strict';

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const { getAIConfig } = require('../../../core/aiAgent');
const userStore = require('../../../stores/userStore');
const { loadUserIdentity } = require('../../../core/memory/userIdentityContext');
const { tokenizeMemoryContext } = require('../../../core/memory/scrubMemoryContext');

/**
 * @returns {Promise<{ memoryContext: string, memorySwap: object|null }>}
 */
async function protectMemoryContext({ memoryContext, userId, conversationId }) {
    let memorySwap = null;
    const identity = await loadUserIdentity(userId, { userStore });
    if (identity.text) memoryContext = '\n\n' + identity.text + memoryContext;
    if (!memoryContext) return { memoryContext, memorySwap };

    try {
        const user = await userStore.getUser(userId).catch(() => null);
        const orgId = user?.organizationId || null;
        const orgShield = orgId ? await configStore.getConfig(`org_privacy_shield_${orgId}`) : null;
        // Shield's master flag is the only switch for PII scrubbing;
        // detectPii() routes to whichever backend is available.
        const scrubEnabled = !!orgShield?.enabled || !!(await getAIConfig())?.piiDetectionEnabled;
        if (!scrubEnabled) return { memoryContext, memorySwap };

        const knownEntities = identity.knownEntities;
        const { text, replacedCategories, mode } = await tokenizeMemoryContext(memoryContext, orgShield, { conversationId: conversationId || null, userId, knownEntities });
        if (replacedCategories.length > 0) {
            log.info(`[DirectChat] Memory context ${mode === 'tokens' ? 'tokenised' : 'scrubbed'}: ${replacedCategories.join(', ')}`);
            if (!conversationId && mode === 'labels') memorySwap = { raw: memoryContext, labelled: text, orgShield, knownEntities };
            memoryContext = text;
        }
    } catch (err) {
        log.warn('[DirectChat] Memory scrub failed (fail-open):', err.message);
    }
    return { memoryContext, memorySwap };
}

module.exports = { protectMemoryContext };

// @typecheck strict
/**
 * What a signed-in member (not a platform admin) gets of GET /ai/config: the
 * fields the chat composer, the agent designer, the settings page, the
 * consumer privacy section and the mobile app read. The rest of that answer
 * is an inventory of the installation — provider endpoint URLs, the internal
 * search-service URL, which keys exist, the DLP ruleset, the service mailbox —
 * and belongs to the admin settings pages only.
 *
 * An allow-list, not a deny-list: a field added to the answer next year stays
 * admin-only until it is put here.
 */

const MEMBER_CONFIG_FIELDS = Object.freeze([
    'allowedModelsByAgentType', 'useAzureDocProcessing',
    'hasGoogleMapsKey', 'voiceChatReady', 'hasElevenLabsKey', 'hasFirefliesKey',
    'hasLinkedInConfig', 'hasWithingsConfig', 'searchProvider',
    'piiDetectionEnabled', 'piiDetectionCategories', 'piiDetectionConfidenceThreshold',
    'piiDetectionScope', 'piiDetectionAction',
    'notebooksEnabled', 'projectsEnabled', 'askAiEnabled', 'exportEnabled',
    'openInNotebookEnabled', 'notebooksMenuEnabled',
    'stripeEnabled', 'stripePublishableKey',
]);

/**
 * The member view of the config answer. `regexGuardrails` is reduced to the
 * collection ids and names the agent designer lists; the rules themselves
 * (the patterns) stay with the admin.
 * @param {Record<string, unknown>} payload the full answer
 * @returns {Record<string, unknown>}
 */
function memberConfigView(payload) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of MEMBER_CONFIG_FIELDS) if (key in payload) out[key] = payload[key];
    const guardrails = /** @type {{ collections?: unknown } | null | undefined} */ (payload.regexGuardrails);
    const collections = Array.isArray(guardrails?.collections) ? guardrails.collections : null;
    out.regexGuardrails = collections
        ? { collections: collections.map((/** @type {{ id?: string, name?: string } | null} */ c) => ({ id: c?.id, name: c?.name })) }
        : null;
    return out;
}

module.exports = { MEMBER_CONFIG_FIELDS, memberConfigView };

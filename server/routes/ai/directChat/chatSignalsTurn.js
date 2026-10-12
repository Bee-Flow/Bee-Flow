'use strict';
/**
 * Direct chat → chat signals (core/privacy/chatSignals.js).
 *
 * One call per direct-chat turn, made right after the input gates resolved
 * (streamTurn.js) or, for the Swarm tier, before its stream starts
 * (swarmTurn.js). It hands the recorder the outcome the Privacy Shield or DLP
 * ALREADY decided on this turn: nothing is scanned again and nothing is read
 * back. Fire-and-forget: both helpers are synchronous, return undefined, never
 * throw and are never awaited; the org lookup runs after the request has moved
 * on.
 *
 * What travels to the recorder: the org key, the surface, the decided outcome,
 * the category ids of what was found in the LAST user message (the PII gate
 * and the DLP scan read nothing else, so a colleague's message earlier in a
 * shared thread can never contribute), the model's provider type and URL (to
 * tell internal from external), the allowlisted hosts, the notice marker and
 * the opt-out switch from the request body. `userId` is passed for the
 * recorder's objection lookup only. No message text, conversation, project or
 * agent ever reaches it.
 *
 * The recorder counts only when the marker in the body is exactly
 * `direct@<current version>`: a client that showed no notice (mobile, API
 * clients, the meeting-notes sidebar, a cached page) is not counted.
 */

const chatSignals = require('../../../core/privacy/chatSignals');

/** The marker and the switch the composer sent; anything else reads as absent. */
function _fromBody(req) {
    const body = req && req.body && typeof req.body === 'object' ? req.body : {};
    return {
        notice: typeof body.chatSignalsNotice === 'string' ? body.chatSignalsNotice : null,
        optOut: body.chatSignalsOptOut === true,
    };
}

/** @param {{ providerType?: string, url?: string }|null|undefined} config */
function _providerOf(config) {
    return config && typeof config === 'object' ? { providerType: config.providerType, url: config.url } : null;
}

/**
 * Resolve the org key (the same lookup /api/privacy/shield-status uses, so the
 * turn counts under exactly the org whose notice the person saw), then count.
 * @param {any} req
 * @param {string} userId
 * @param {object} turn everything countTurn needs except the org key
 */
function _countLater(req, userId, turn) {
    void (async () => {
        let orgId = null;
        try {
            orgId = await require('../../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
        } catch (_) { orgId = null; }
        chatSignals.countTurn({ ...turn, orgKey: chatSignals.directOrgKey(orgId), userId });
    })().catch(() => {});
}

/**
 * Count a direct-chat turn from what runInputGates decided.
 *
 * Called once, after runInputGates resolved, whether it returned the gate
 * state or undefined (a gate ended the stream: protection unavailable, a PII
 * block, a DLP block, a regex block). A throw from the gates skips the call,
 * so an unexpected error is never counted.
 *
 * @param {{ req: any, userId: string, config: any,
 *   chatSignal: { pii: { status?: string, decision?: string, categories?: string[] }, dlp: any, allowlistedHosts: string[] } }} p
 * @returns {undefined}
 */
function countDirectTurn({ req, userId, chatSignal, config }) {
    try {
        // Snapshot synchronously: what the gates decided, as it stands now.
        const dlp = chatSignal && chatSignal.dlp ? chatSignal.dlp : null;
        const pii = chatSignal && chatSignal.pii && typeof chatSignal.pii === 'object' ? chatSignal.pii : {};
        const outcome = dlp
            ? chatSignals.outcomeFromDlp(dlp)
            : (chatSignals.outcomeFromPiiReport(pii) || 'unscanned');
        const found = dlp ? dlp.categories : pii.categories;
        const categories = Array.isArray(found) ? found.filter(c => typeof c === 'string') : [];
        const hosts = chatSignal && Array.isArray(chatSignal.allowlistedHosts) ? chatSignal.allowlistedHosts : [];
        _countLater(req, userId, {
            surface: 'direct',
            ..._fromBody(req),
            outcome,
            categories,
            providerConfig: _providerOf(config),
            allowlistedHosts: hosts,
            dryRun: false,
        });
    } catch (_) { /* counting never touches the turn */ }
    return undefined;
}

/**
 * Count a turn whose outcome is fixed in advance because no gate runs on it:
 * the Swarm tier sends the message to its workers unscanned. Without a
 * provider config the destination reads `unknown` (which the coverage check
 * treats as external), so the known gap is visible without a scan.
 *
 * @param {{ req: any, userId: string, surface?: string, outcome?: string,
 *   providerConfig?: { providerType?: string, url?: string }|null }} p
 * @returns {undefined}
 */
function countFixedTurn({ req, userId, surface = 'direct', outcome = 'unscanned', providerConfig = null }) {
    try {
        _countLater(req, userId, {
            surface,
            ..._fromBody(req),
            outcome,
            categories: [],
            providerConfig: _providerOf(providerConfig),
            allowlistedHosts: [],
            dryRun: false,
        });
    } catch (_) { /* counting never touches the turn */ }
    return undefined;
}

module.exports = { countDirectTurn, countFixedTurn };

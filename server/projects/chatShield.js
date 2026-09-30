// @typecheck
/**
 * The Privacy Shield passage for the team chat assistant.
 *
 * The assistant is a server-side, non-interactive AI call: there is no SSE
 * channel to ask the person anything on, and the reply arrives as a message
 * later. It applies the shield the way the other server paths of that shape
 * do, and in the same order as direct chat:
 *
 *   1. Unicode smuggling is stripped first (agentRuntime/chatWithAgent.js).
 *   2. The shield is resolved for the ASKING member (resolveShieldFor: their
 *      org's shield, or their own personal shield without an org).
 *   3. With the org's interactive DLP gate on (`enabled && dlpEnabled`), the
 *      outbound text goes through dlpRunner.scan, mapped for a path that
 *      cannot ask, exactly like the meeting report (routes/transcriptions/
 *      report.js): block → no call; redact → tokenised text; ask → the
 *      conservative choice, redact. A scan that throws blocks: fail closed.
 *   4. Otherwise the PII passage the agent path runs (validateInputForPii with
 *      the same arguments): masking actions tokenise, a PII block or a
 *      fail-closed "protection unavailable" blocks, any other detector error
 *      fails open — the agent path's semantics, unchanged.
 *   5. The answer is un-tokenised with the same untokeniser the other paths
 *      use, and the per-run token map is dropped afterwards.
 *
 * Every `conversationId` handed in is a PER-RUN scope with no conversation
 * row behind it, so the DLP calls are `ephemeral`: the token map is never
 * written through to (or cleared from) the database, no owner is looked up
 * for it, and nothing about the scope outlives `release`.
 *
 * Knowledge-base passages are stripped of the shield's "own server" block
 * list with toolPiiGate.injectedPassagesPrompt, as direct chat and the agent
 * runtime do (see chatAssistant.js).
 *
 * A block is reported as a PrivacyBlocked error (code PRIVACY_BLOCKED). The
 * assistant turns it into `chat.ai.finished {status:'blocked'}` — never the
 * reason text, never any content. What was found is written to the guardrail
 * events as categories and counts only, like every other path.
 *
 * Every dependency is injectable; the defaults are required lazily.
 */

'use strict';

const log = require('../telemetry/log');

class PrivacyBlocked extends Error {
    /** @param {string} reason a short machine reason, never content */
    constructor(reason) {
        super(`The Privacy Shield stopped this request (${reason}).`);
        this.name = 'PrivacyBlocked';
        this.code = 'PRIVACY_BLOCKED';
        this.reason = reason;
    }
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.resolveShieldFor]     ({orgId, userId}) => shield|null
 * @param {Function} [deps.getAIConfig]          () => global AI config
 * @param {object}   [deps.dlp]                  { scan, applyRedactionChoice, clearConversationState }
 * @param {Function} [deps.validateInputForPii]  core/privacy/piiDetection.validateInputForPii
 * @param {Function} [deps.logGuardrailEvent]    stores/guardrailEventStore.logGuardrailEvent
 * @param {string}   [deps.source]               guardrail event source: `project_chat` (the
 *                                               answer), `project_chat_gate` (the relevance
 *                                               gate), `project_comment_gate`, …
 */
function makeChatShield(deps = {}) {
    const source = typeof deps.source === 'string' && deps.source ? deps.source : 'project_chat';
    const resolveShieldFor = deps.resolveShieldFor
        || ((args) => require('../core/privacy/orgShield').resolveShieldFor(args));
    const getAIConfig = deps.getAIConfig || (() => require('../core/aiAgent').getAIConfig());
    const dlp = () => deps.dlp || require('../core/dlp/dlpRunner');
    const validateInputForPii = deps.validateInputForPii
        || ((...args) => require('../core/privacy/piiDetection').validateInputForPii(...args));
    const logGuardrailEvent = deps.logGuardrailEvent
        || ((event) => require('../stores/guardrailEventStore').logGuardrailEvent(event));

    function audit(base, fields) {
        try {
            Promise.resolve(logGuardrailEvent({ ...base, ...fields, direction: 'input', source })).catch(() => {});
        } catch (_) { /* auditing never decides the outcome */ }
    }

    /** The kinds of thing that were replaced, as labels only (never the values). */
    const categoriesOf = (list, summary) => {
        const fromList = [...new Set((list || []).map((e) => e && (e.label || e.category)).filter(Boolean))];
        return fromList.length ? fromList : Object.keys(summary || {});
    };
    const labelsOf = (list) => [...new Set((list || []).map((e) => e && (e.label || e.category)).filter(Boolean))].join(', ');

    /**
     * The shield that applies to this member. A lookup that fails is a block:
     * with no answer we cannot know whether this org requires redaction.
     */
    async function resolve({ orgId, userId }) {
        try {
            return await resolveShieldFor({ orgId: orgId || null, userId });
        } catch (err) {
            log.error('[ProjectChat] Privacy Shield lookup failed, not calling the model:', err && err.message);
            throw new PrivacyBlocked('shield_unavailable');
        }
    }

    /**
     * Prepare the text that leaves for the model.
     *
     * @param {object} p
     * @param {object|null} p.shield           from resolve()
     * @param {string|null} p.orgId
     * @param {string} p.userId
     * @param {string} p.text                  the outbound user message
     * @param {string} p.conversationId        the per-run DLP scope
     * @param {object} [p.providerConfig]      { providerType, url, displayName }
     * @param {object} [p.auditBase]           ids for the guardrail event row
     * @returns {Promise<{ text: string, tokenMap: Record<string,string>|null, categories?: string[] }>}
     */
    async function protect({ shield, orgId, userId, text, conversationId, providerConfig = {}, auditBase = {} }) {
        const messages = [{ role: 'user', content: String(text || '') }];
        const { sanitizeMessagesUnicode } = require('../utils/unicodeSanitizer');
        const unicode = sanitizeMessagesUnicode(messages);
        if (unicode.smugglingDetected) {
            log.warn(`[ProjectChat] Unicode smuggling stripped: ${unicode.totalStripped} hidden chars`);
        }
        let outbound = /** @type {string} */ (messages[0].content);
        const base = { organization_id: orgId || null, user_id: userId, ...auditBase };

        if (shield?.enabled && shield?.dlpEnabled) {
            let scan;
            try {
                scan = await dlp().scan({
                    messages: [{ role: 'user', content: outbound }],
                    orgShieldConfig: shield,
                    orgId: orgId || null,
                    conversationId,
                    providerConfig,
                    ephemeral: true,
                });
            } catch (err) {
                // FAIL CLOSED: the org asked for the gate and it could not run.
                log.error('[ProjectChat] DLP scan failed, not calling the model:', err && err.message);
                audit(base, { violation_type: 'pii_unavailable', violation_categories: 'privacy_protection_unavailable', action_taken: 'blocked' });
                throw new PrivacyBlocked('scan_failed');
            }
            if (scan.action === 'block') {
                audit(base, { violation_type: 'pii', violation_categories: Object.keys(scan.summary || {}).join(', ') || scan.reason || 'blocked', action_taken: 'blocked' });
                throw new PrivacyBlocked(scan.reason || 'dlp_block');
            }
            if (scan.action === 'redact') {
                audit(base, { violation_type: 'pii', violation_categories: Object.keys(scan.summary || {}).join(', '), action_taken: 'tokenized' });
                return { text: scan.redactedText || outbound, tokenMap: scan.tokenMap || null, categories: categoriesOf(scan.findings, scan.summary) };
            }
            if (scan.action === 'ask') {
                // Nobody to ask: take the conservative choice.
                const applied = await dlp().applyRedactionChoice({ conversationId, text: outbound, findings: scan.findings, ephemeral: true });
                audit(base, { violation_type: 'pii', violation_categories: labelsOf(scan.findings), action_taken: 'tokenized' });
                return { text: applied.tokenizedText || outbound, tokenMap: applied.tokenMap || null, categories: categoriesOf(scan.findings) };
            }
            return { text: outbound, tokenMap: null };
        }

        const aiConfig = await getAIConfig();
        const orgPiiEnabled = !!shield?.enabled;
        if (!(aiConfig?.piiDetectionEnabled || orgPiiEnabled)) return { text: outbound, tokenMap: null };
        try {
            const result = await validateInputForPii(
                [{ role: 'user', content: outbound }], orgPiiEnabled, shield || null,
                null, // no per-call action override
                null, // no accumulated token map: every run stands alone
                { vaultUserId: userId || null },
            );
            if (result && result.tokenizedText) {
                outbound = result.tokenizedText;
                audit(base, { violation_type: 'pii', violation_categories: labelsOf(result.entities), action_taken: 'tokenized' });
                return { text: outbound, tokenMap: result.tokenMap || null, categories: categoriesOf(result.entities) };
            }
            return { text: outbound, tokenMap: null };
        } catch (err) {
            if (err?.privacyUnavailable) {
                audit(base, { violation_type: 'pii_unavailable', violation_categories: 'privacy_protection_unavailable', action_taken: 'blocked' });
                throw new PrivacyBlocked('pii_unavailable');
            }
            if (err?.message?.includes('PII Detected')) {
                audit(base, { violation_type: 'pii', violation_categories: labelsOf(err.piiEntities), action_taken: 'blocked' });
                throw new PrivacyBlocked('pii_block');
            }
            // The detector itself failed: fail open, exactly like the agent path.
            log.warn('[ProjectChat] PII check error (fail-open):', err && err.message);
            return { text: outbound, tokenMap: null };
        }
    }

    /**
     * The gate around the tool calls of one answer: `refuse` looks at what a
     * tool is about to be given (the same block lists a normal chat applies to
     * tool calls), `forModel` at what it hands back. Both do nothing without
     * an enabled shield.
     */
    function toolGate({ shield, orgId, userId, auditBase = {} }) {
        const base = { organization_id: orgId || null, user_id: userId, ...auditBase };
        return require('../core/privacy/toolPiiGate').toolLoopGate({
            shield: shield || null,
            tag: 'ProjectChat',
            audit: async (fields) => { audit(base, fields); },
        });
    }

    /** What the model wrote as tool arguments, with the placeholders replaced by the real values. */
    function restoreArgs(args, tokenMap) {
        return require('../core/dlp/applyTokenMapToOutbound').untokeniseToolArgs(args, tokenMap);
    }

    /** The token-preservation rules for the system prompt, or ''. */
    function tokenAddendum(tokenMap) {
        if (!tokenMap || Object.keys(tokenMap).length === 0) return '';
        return require('../core/dlp/tokenPreservationPrompt').buildTokenPreservationAddendum(tokenMap);
    }

    /** Put the real values back into the answer. */
    function restore(text, tokenMap) {
        if (!text || !tokenMap || Object.keys(tokenMap).length === 0) return text;
        const u = require('../core/dlp/untokeniseStream').createUntokeniser(tokenMap);
        return u.push(text) + u.flush();
    }

    /** Drop the per-run token map from process memory. Never throws. */
    function release(conversationId) {
        try { dlp().clearConversationState(conversationId, { ephemeral: true }); } catch (_) { /* nothing held */ }
    }

    return { resolve, protect, tokenAddendum, restore, release, toolGate, restoreArgs };
}

module.exports = { makeChatShield, PrivacyBlocked };

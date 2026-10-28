/** @typedef {import('../../../core/agentRuntime/inputPiiGate').PiiTokenisationInfo} PiiTokenisationInfo */
/** @typedef {import('../../../core/agentRuntime/chatStream/turnState').ChatMessage} ChatMessage */
// @typecheck
/**
 * Direct Chat — the inbound safety gates that run between prompt assembly and
 * the LLM call, in order: Unicode-smuggling defense and the Privacy Shield
 * resolution incl. the super-admin sole-org fallback (inputShield.js), the
 * PII detection gate (block/tokenize) and the interactive pre-flight DLP
 * scanner (inputPrivacyGates.js), and the regex guardrails on user input
 * (inputRegexGate.js).
 *
 * Returns the resolved shield/moderation/PII state — or undefined when a gate
 * blocked the turn, in which case the SSE stream has already been ended and
 * the caller must stop.
 */

const {
    stripUnicodeSmuggling, logUnicodeSmuggling, resolveTurnOrgId, resolveTurnShield, applyModerationViolation,
} = require('./inputShield');
const { runPiiGate, runDlpGate } = require('./inputPrivacyGates');
const { resolveRegexConfig, applyInputRegex } = require('./inputRegexGate');

async function runInputGates({ req, res, send, userId, convId, message, messages, modelId, config, hasAttachments = false, volatileMessage = null, chatSignal = null }) {
    // Per-turn addenda go on the VOLATILE system block, never on messages[0].
    // The stable block is the provider-cached prefix: one appended byte there
    // re-reads the whole prompt on a self-hosted model and re-writes the 1h
    // cache on Claude. Falls back to the LAST system message, which at this
    // point in the turn is the volatile block at index 1 — never index 0.
    const appendVolatile = (text) => {
        if (!text) return;
        const target = volatileMessage || [...messages].reverse().find(m => m && m.role === 'system');
        if (target && typeof target.content === 'string') target.content += text;
    };

    // Must run FIRST, before moderation, PII and regex guardrails.
    const unicodeResult = stripUnicodeSmuggling(messages, send);
    const userOrgId = await resolveTurnOrgId(req);
    logUnicodeSmuggling(unicodeResult, { userOrgId, userId, convId, modelId });

    const { orgShield, shieldSource } = await resolveTurnShield(req, { userOrgId, userId });
    const webSearchGuardEnabled = !!(orgShield?.enabled && orgShield?.webSearchGuardEnabled);
    // Chat signals (./chatSignalsTurn.js): the caller's accumulator learns
    // what the gates below decide. Host names and decisions only.
    if (chatSignal) chatSignal.allowlistedHosts = Array.isArray(orgShield?.dlpAllowlistedHosts) ? orgShield.dlpAllowlistedHosts : [];

    // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed when
    // the Azure Content Safety backend was dropped; PII detection still runs
    // below. The flag stays part of the turn's contract.
    const moderationViolation = null;
    if (moderationViolation) applyModerationViolation(messages, appendVolatile);

    // Privacy / DLP metadata, attached to the saved user/assistant messages
    // just before persistence so the redaction badge and the "How I got this
    // answer" panel survive a page refresh. `tokenizedMessage` mirrors
    // `message` for the non-LLM consumers (DB persistence, memory extraction,
    // title generator): once PII tokenisation fires it is the redacted form.
    /** @type {Record<string, string> | undefined | null} */
    let piiTokenMap = null;
    let tokenizedMessage = message;
    /** @type {{ piiTokenizedCount: number; piiCategories: string[]; } | { dlpRedactedCount: number; dlpCategories: string[]; } | undefined | null} */
    let _userPrivacyMeta = null;
    /** @type {PiiTokenisationInfo | undefined | null} */
    let _assistantTokenisationInfo = null;
    const g = { req, res, send, userId, convId, messages, modelId, config, hasAttachments, chatSignal, appendVolatile, userOrgId, orgShield, shieldSource };

    const pii = await runPiiGate(g);
    if (pii.blocked) return undefined;
    if ('tokenizedMessage' in pii) {
        piiTokenMap = pii.piiTokenMap;
        tokenizedMessage = pii.tokenizedMessage;
        _userPrivacyMeta = pii.userPrivacyMeta;
        _assistantTokenisationInfo = pii.assistantInfo;
    }

    if (orgShield?.enabled && orgShield?.dlpEnabled) {
        const dlp = await runDlpGate(g);
        if (dlp.blocked) return undefined;
        if ('piiTokenMap' in dlp) piiTokenMap = dlp.piiTokenMap;
        if (dlp.userPrivacyMeta) _userPrivacyMeta = dlp.userPrivacyMeta;
        if (dlp.assistantInfo) _assistantTokenisationInfo = dlp.assistantInfo;
    }

    const regexConfig = await resolveRegexConfig(orgShield, shieldSource);
    if (!applyInputRegex({ messages, message, regexConfig, send })) {
        send('done', {});
        res.end();
        return undefined;
    }
    return { userOrgId, moderationViolation, _userPrivacyMeta, _assistantTokenisationInfo, orgShield, webSearchGuardEnabled, piiTokenMap, tokenizedMessage, regexConfig };
}

module.exports = { runInputGates };

// @typecheck noImplicitAny
const { resolveShieldFor, mergeWithOrgShield } = require('../privacy/orgShield');
const { checkRegexPatterns } = require('../privacy/guardrails');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
const { runInputPiiGate } = require('./inputPiiGate');
const { validateInputForPii } = require('../privacy/piiDetection');
const { startPrivacyScanPhase, messageText } = require('./phaseEvents');

// What ./inputPiiGate works with, handed in: it sits in the server's large
// import cycle, which that module stays out of. The DLP runner stays lazily
// required, as it always was.
const PII_GATE_DEPS = {
    validateInputForPii, startPrivacyScanPhase, messageText,
    dlpRunner: () => require('../dlp/dlpRunner'),
};
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');

/**
 * @typedef {{ enabled?: boolean, scope?: Record<string, boolean>, action?: string, rulesWithNames?: Array<{ name: string, pattern: string }> }} RegexGuardConfig
 * @typedef {{ rules?: Array<{ id: string, name: string, pattern: string }>, collections?: Array<{ id: string, ruleIds?: string[] }> }} GlobalRegexGuardrails  the stored global rule set
 */

// `isDryRun` marks every guardrail row of this turn as a dry run — the test
// chat (A4) sets it, so a builder's experiment does not land among the
// production turns in the org's Privacy Shield activity. The same column the
// automation runner sets for a dry run.
/**
 * @param {{ agent: import('./chatStream/turnState').AgentRow, messages: import('./chatStream/turnState').ChatMessage[], userMessage: string, globalConfig: import('../llm/providerConfig').AIConfig, onEvent: import('./chatStream/turnState').OnEvent, userId: string, conversationId: string | null, source?: string, model?: string | null, isDryRun?: boolean }} opts
 */
async function runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent, userId, conversationId, source, model, isDryRun = false }) {
    /** @type {string | null} */
    let guardrailViolation = null;
    // What the PII gate decided on this turn (validate.js `options.report`),
    // handed back as `piiReport` for chat signals (core/privacy/chatSignals.js).
    // Status, decision and category ids only.
    /** @type {import('../privacy/piiDetection/validate').PiiGateReport} */
    const piiReport = {};

    // Context for guardrail event logging
    const eventCtx = {
        organization_id: agent.organization_id || null,
        user_id: userId || null,
        agent_id: agent.id || null,
        agent_name: agent.name || null,
        conversation_id: conversationId || null,
        source: source || 'unknown',
        model: model || null,
        is_dry_run: !!isDryRun,
    };

    // ── Unicode Smuggling Defense (must run FIRST) ───────────────────
    let processedUserMessage = stripUnicodeSmuggling({ messages, userMessage, onEvent, eventCtx });

    // Resolve the shield once, not per check.
    // applies the tier clamps internally, so stale pre-clamp data (e.g.
    // `webSearchGuardEnabled: true` saved before the second-wave tightening)
    // cannot enforce on a community install.
    //
    // Agents owned by a consumer account have `organization_id === null`; those
    // fall back to the user's personal Privacy Shield, otherwise PII detection
    // silently no-ops for every personal-account agent conversation — the
    // agent-path twin of BFSF-290.
    const orgShield = await resolveShieldFor({ orgId: agent.organization_id, userId });

    const webSearchGuardEnabled = !!(orgShield?.enabled && orgShield?.webSearchGuardEnabled) || !!agent.config?.webSearchGuardEnabled;
    const disableSearchOnUpload = !!(orgShield?.enabled && orgShield?.disableSearchOnUpload);
    const webSearchGuardPiiCategories = (orgShield?.enabled && Array.isArray(orgShield?.webSearchGuardPiiCategories) && orgShield.webSearchGuardPiiCategories.length > 0)
        ? orgShield.webSearchGuardPiiCategories : null;

    // ── PII Detection ─────────────────────────────────────────────────
    const orgPiiEnabled = !!orgShield?.enabled;
    // When the org has the interactive DLP gate enabled, skip the auto-tokenising
    // path here — the downstream dlpRunner call in the turn preflight will do the
    // scan and apply the user's chosen action (ask/redact/block). Running both
    // leads to double scans and conflicting actions.
    const dlpWillHandle = !!(orgShield?.enabled && orgShield?.dlpEnabled);
    if (dlpWillHandle) piiReport.status = 'deferred_to_dlp';
    else if (!(globalConfig?.piiDetectionEnabled || orgPiiEnabled)) piiReport.status = 'disabled';
    /** @type {import('./inputPiiGate').PiiGateOut} */
    let pii = { moderationViolation: null, processedUserMessage, userPrivacyMeta: null, assistantTokenisationInfo: null };
    if (!dlpWillHandle && (globalConfig?.piiDetectionEnabled || orgPiiEnabled)) {
        pii = await runInputPiiGate({ messages, orgShield, orgPiiEnabled, onEvent, userId, conversationId, model, eventCtx, piiReport, processedUserMessage }, PII_GATE_DEPS);
    }
    processedUserMessage = pii.processedUserMessage;

    // Reuse the shield resolved at the top of this run (org shield, or the
    // personal user shield for consumer-owned agents).
    const regexConfig = mergeWithOrgShield(orgShield, agentLocalRegexConfig(agent, globalConfig));

    // Regex guardrails on the user input (redact into the PII-processed copy).
    {
        const rx = applyRegexGuardrails({ text: userMessage, redactBase: processedUserMessage, regexConfig, scope: 'userInput', emit: onEvent, audit: eventCtx, direction: 'input' });
        if (rx.action === 'redact') processedUserMessage = rx.processedText;
        else if (rx.action === 'block') guardrailViolation = rx.ruleNames;
    }

    return {
        moderationViolation: pii.moderationViolation,
        guardrailViolation,
        processedUserMessage,
        regexConfig,
        webSearchGuardEnabled,
        disableSearchOnUpload,
        webSearchGuardPiiCategories,
        userPrivacyMeta: pii.userPrivacyMeta,
        assistantTokenisationInfo: pii.assistantTokenisationInfo,
        piiReport: {
            status: piiReport.status || 'unscanned',
            decision: piiReport.decision || null,
            categories: Array.isArray(piiReport.categories) ? piiReport.categories : [],
        },
    };
}

/**
 * Strip hidden Unicode from `messages` (in place). Resolves to the processed
 * user message: the sanitized last message when it is a plain user string,
 * otherwise `userMessage` unchanged.
 * @param {{ messages: import('./chatStream/turnState').ChatMessage[], userMessage: string, onEvent: import('./chatStream/turnState').OnEvent, eventCtx: import('./inputPiiGate').GuardrailEventCtx }} opts
 * @returns {string}
 */
function stripUnicodeSmuggling({ messages, userMessage, onEvent, eventCtx }) {
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (!unicodeResult.smugglingDetected) return userMessage;
    let processedUserMessage = userMessage;
    log.warn(`[GuardrailsRunner] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
    // Update processedUserMessage if the last user message was sanitized
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string') {
        processedUserMessage = lastMsg.content;
    }
    if (onEvent) {
        onEvent('unicode_smuggling_detected', {
            strippedCount: unicodeResult.totalStripped,
            messageIndices: unicodeResult.detectedIn,
        });
    }
    guardrailEventStore.logGuardrailEvent({
        ...eventCtx,
        violation_type: 'unicode_smuggling',
        violation_categories: `${unicodeResult.totalStripped} hidden chars`,
        direction: 'input',
        action_taken: 'stripped',
    }).catch((e) => bestEffort('core/agentRuntime/guardrailsRunner:stripUnicodeSmuggling', e));
    return processedUserMessage;
}

/**
 * The agent's own regex guardrails (its collections resolved against the
 * global rule set), or null when it has none enabled or none resolve.
 * @param {import('./chatStream/turnState').AgentRow} agent
 * @param {import('../llm/providerConfig').AIConfig} globalConfig
 * @returns {RegexGuardConfig | null}
 */
function agentLocalRegexConfig(agent, globalConfig) {
    const agentRegexConfig = agent.config?.regexGuardrails;
    if (!agentRegexConfig?.enabled) return null;
    const globalRegexConfig = /** @type {GlobalRegexGuardrails} */ (globalConfig?.regexGuardrails || {});
    const globalRules = globalRegexConfig.rules || [];
    const globalCollections = globalRegexConfig.collections || [];

    /** @type {{ name: string; pattern: string; }[]} */
    const rulesWithNames = [];
    for (const colId of agentRegexConfig.collectionIds || []) {
        const collection = globalCollections.find(c => c.id === colId);
        if (!collection) continue;
        for (const ruleId of collection.ruleIds || []) {
            const rule = globalRules.find(r => r.id === ruleId);
            if (rule?.pattern) {
                rulesWithNames.push({ name: rule.name, pattern: rule.pattern });
            }
        }
    }

    const scope = agentRegexConfig.scope || { userInput: true, agentOutput: true, toolInput: false, toolOutput: false };
    const action = agentRegexConfig.action || 'delete';
    return rulesWithNames.length > 0 ? { enabled: true, rulesWithNames, scope, action } : null;
}

/**
 * Apply regex guardrails to a piece of text (input or output scope).
 *
 * Encapsulates the copy-pasted scan + `[REDACTED: name]` redact loop + the
 * content_redact / guardrail_violation emit shapes + the (optional) guardrail
 * audit row. Callers keep their own message mutation, response termination, and
 * debug logging — those diverge per surface (the agent path sets a flag and
 * continues; the routes end the SSE stream) and must not be unified.
 *
 * @param {Object}   p
 * @param {string}   p.text         Text to SCAN (also the default redact base).
 * @param {string}   [p.redactBase] Text to redact into when it differs from the
 *   scan text (the agent path scans the raw message but redacts the already
 *   PII-tokenised copy). Defaults to `text`.
 * @param {RegexGuardConfig | null} p.regexConfig  Merged shield/local config ({enabled, scope, action, rulesWithNames}).
 * @param {string}   p.scope        Which scope flag to honour ('userInput' | 'agentOutput' | ...).
 * @param {import('./chatStream/turnState').OnEvent} [p.emit]       (type, data) => void — onEvent (agent) / send (route).
 * @param {Object}   [p.audit]      Base fields for logGuardrailEvent. Omit to skip the audit row
 *   (the direct-chat path deliberately does not log regex events).
 * @param {string}   [p.direction]  Audit direction ('input' | 'output'). Default 'input'.
 * @returns {{action:'pass'|'redact'|'block', processedText:string, ruleNames:(string|null)}}
 */
function applyRegexGuardrails({ text, redactBase, regexConfig, scope, emit, audit, direction = 'input' }) {
    const base = redactBase !== undefined ? redactBase : text;
    if (!regexConfig?.enabled || !regexConfig?.scope?.[scope]) {
        return { action: 'pass', processedText: base, ruleNames: null };
    }
    const matches = checkRegexPatterns(text, regexConfig.rulesWithNames);
    if (matches.length === 0) {
        return { action: 'pass', processedText: base, ruleNames: null };
    }
    const ruleNames = matches.map(m => m.ruleName).join(', ');

    if (regexConfig.action === 'redact') {
        let processedText = base;
        for (const rule of regexConfig.rulesWithNames) {
            try {
                const regex = new RegExp(rule.pattern, 'gi');
                processedText = processedText.replace(regex, `[REDACTED: ${rule.name}]`);
            } catch (e) { fallback('core/agentRuntime/guardrailsRunner:applyRegexGuardrails', e); /* skip invalid patterns */ }
        }
        emit?.('content_redact', { originalMessage: text, redactedMessage: processedText, rules: ruleNames, autoRedactSeconds: 5 });
        if (audit) {
            guardrailEventStore.logGuardrailEvent({ ...audit, violation_type: 'regex', violation_categories: ruleNames, direction, action_taken: 'redacted' }).catch((e) => bestEffort('core/agentRuntime/guardrailsRunner:applyRegexGuardrails#2', e));
        }
        return { action: 'redact', processedText, ruleNames };
    }

    emit?.('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
    if (audit) {
        guardrailEventStore.logGuardrailEvent({ ...audit, violation_type: 'regex', violation_categories: ruleNames, direction, action_taken: 'blocked' }).catch((e) => bestEffort('core/agentRuntime/guardrailsRunner:applyRegexGuardrails#3', e));
    }
    return { action: 'block', processedText: base, ruleNames };
}

module.exports = { runInputGuardrails, applyRegexGuardrails };

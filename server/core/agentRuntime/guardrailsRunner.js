const { validateInputForPii } = require('../privacy/piiDetection');
const { startPrivacyScanPhase, messageText } = require('./phaseEvents');
const { resolveShieldFor, mergeWithOrgShield } = require('../privacy/orgShield');
const { checkRegexPatterns } = require('../privacy/guardrails');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
const log = require('../../telemetry/log');

// `isDryRun` markeert elke guardrail-rij van deze beurt als droogloop — de
// testchat (A4) zet hem, zodat een experiment van de bouwer niet tussen de
// productiebeurten in de org-privacy-shield-activiteit terechtkomt. Dezelfde
// kolom die de automation-runner voor een droge run zet.
async function runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent, userId, conversationId, source, model, isDryRun = false }) {
    let moderationViolation = null;
    let guardrailViolation = null;
    let processedUserMessage = userMessage;
    let userPrivacyMeta = null;
    let assistantTokenisationInfo = null;
    // What the PII gate decided on this turn (validate.js `options.report`),
    // handed back as `piiReport` for chat signals (core/privacy/chatSignals.js).
    // Status, decision and category ids only.
    const piiReport = {};

    // ── Unicode Smuggling Defense (must run FIRST) ───────────────────
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
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
            organization_id: agent.organization_id || null,
            user_id: userId || null,
            agent_id: agent.id || null,
            agent_name: agent.name || null,
            conversation_id: conversationId || null,
            violation_type: 'unicode_smuggling',
            violation_categories: `${unicodeResult.totalStripped} hidden chars`,
            direction: 'input',
            action_taken: 'stripped',
            source: source || 'unknown',
            model: model || null,
            is_dry_run: !!isDryRun,
        }).catch(() => {});
    }

    // Resolve the shield once (was previously read 3 times). `resolveShieldFor`
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

    // ── PII Detection ─────────────────────────────────────────────────
    // Single backend: the PII Guard service (GLiNER). If the guard isn't
    // installed, detectPii() returns null and the chat path fails open.
    const orgPiiEnabled = !!orgShield?.enabled;
    // When the org has the interactive DLP gate enabled, skip the auto-tokenising
    // path here — the downstream dlpRunner call in chatStream.js will do the scan
    // and apply the user's chosen action (ask/redact/block). Running both leads to
    // double scans and conflicting actions.
    const dlpWillHandle = !!(orgShield?.enabled && orgShield?.dlpEnabled);
    if (dlpWillHandle) piiReport.status = 'deferred_to_dlp';
    else if (!(globalConfig?.piiDetectionEnabled || orgPiiEnabled)) piiReport.status = 'disabled';
    if (!dlpWillHandle && (globalConfig?.piiDetectionEnabled || orgPiiEnabled)) {
        try {
            const piiMessages = [
                ...messages.slice(-3), // last few messages for context
            ];
            // Seed the tokeniser with what this conversation has already
            // minted. Without it every turn restarts at [email_1], so turn 2's
            // token silently overwrites turn 1's mapping in the merged
            // conversation map below — and the un-tokeniser then restores the
            // WRONG address into the assistant's reply. The DLP path has always
            // done this (dlp/dlpRunner.js:344-352); this path never did.
            // Async so a conversation resumed after a restart hydrates its map
            // from the DB first rather than starting from 1 again.
            let existingTokenMap = null;
            try {
                existingTokenMap = await require('../dlp/dlpRunner').getConversationTokenMapAsync(conversationId);
            } catch (_) { /* non-fatal — worst case we start fresh, as before */ }

            // Same status line the direct-chat path shows: a big paste is
            // scanned window by window and takes minutes, and the agent path
            // reported nothing at all while it did.
            const _ps = startPrivacyScanPhase(onEvent, messageText(messages[messages.length - 1]));
            let piiResult;
            try {
                piiResult = await validateInputForPii(piiMessages, orgPiiEnabled, orgShield, null, existingTokenMap, { vaultUserId: userId || null, onProgress: _ps.onProgress, report: piiReport });
            } finally {
                _ps.end();
            }

            if (piiResult && piiResult.tokenizedText) {
                // Redact/tokenize mode: replace user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (lastMsg && lastMsg.role === 'user') {
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = piiResult.tokenizedText;
                        processedUserMessage = piiResult.tokenizedText;
                    } else if (Array.isArray(lastMsg.content)) {
                        const textPart = lastMsg.content.find(p => p.type === 'text');
                        if (textPart) {
                            textPart.text = piiResult.tokenizedText;
                            processedUserMessage = piiResult.tokenizedText;
                        }
                    }
                }
                log.warn(`[GuardrailsRunner] 🔒 PII redacted (${Object.keys(piiResult.tokenMap).length} tokens)`);

                // Stash the token map on the shared conversation-scoped store so
                // chatStream's un-tokeniser wrapper restores these values on the
                // response. Without this step the tokens leak through to the UI
                // whenever DLP itself is disabled.
                try {
                    require('../dlp/dlpRunner').mergeTokenMap(conversationId, piiResult.tokenMap);
                } catch (_) { /* non-fatal — missing dlpRunner just means no restoration */ }

                // Let the LLM know that the placeholders in the user's message are
                // redaction tokens and it should echo them back unchanged. Match the
                // format emitted by piiDetection.js → `[email_1]`, `[phone_2]`, …
                if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
                    const categoryList = [...new Set(piiResult.entities.map(e => e.label || e.category))].join(', ');
                    messages[0].content += `\n\n[PRIVACY MODE ACTIVE — strict rules (${categoryList}):
- Sensitive values in the user's message and retrieved memories have been replaced with placeholders like [email_1], [phone_2] or [iban_1].
- When referring to these values in your response, write the SAME placeholder verbatim. The system restores the real value for the user automatically.
- DO NOT infer, guess, describe, or reveal any property of the underlying data — no digits, no check-codes, no institution names, no country codes derived from the placeholder, no example values, no "it starts with…".
- If the user asks a question whose answer would require those inferred properties (e.g. "which bank is my IBAN from?"), answer based only on what YOU can see: placeholders. Say you cannot determine the answer from the protected data and suggest the user check directly.
- Never invent values; never reveal the token map.]`;
                }

                if (onEvent) {
                    onEvent('pii_tokenized', {
                        entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
                        tokenCount: Object.keys(piiResult.tokenMap).length,
                    });

                    // Transparency: when the org enables `showRawPayload`, also
                    // emit the exact tokenised string that's about to be sent
                    // to the LLM. The user's "How I got this answer" panel uses
                    // this to show the real outbound payload. Opt-in per org.
                    if (orgShield?.showRawPayload && piiResult.tokenizedText) {
                        onEvent('privacy_payload', {
                            tokenizedPrompt: piiResult.tokenizedText,
                            provider: model || null,
                            source: 'pii',
                            timestamp: Date.now(),
                        });
                        if (piiResult.tokenMap && Object.keys(piiResult.tokenMap).length > 0) {
                            onEvent('privacy_token_map', { tokenMap: piiResult.tokenMap, source: 'pii' });
                        }
                    }
                }

                // Persistence accumulators returned to the caller (chatStream)
                // so the redaction badge + privacy panel survive page refreshes.
                {
                    const piiCats = [...new Set(piiResult.entities.map(e => e.label || e.category).filter(Boolean))];
                    const piiCount = Object.keys(piiResult.tokenMap).length;
                    userPrivacyMeta = { piiTokenizedCount: piiCount, piiCategories: piiCats };
                    assistantTokenisationInfo = {
                        source: 'pii',
                        action: 'redact',
                        count: piiCount,
                        categories: piiCats,
                        provider: model || null,
                        automatic: true,
                    };
                    if (orgShield?.showRawPayload && piiResult.tokenizedText) {
                        assistantTokenisationInfo.tokenizedPrompt = piiResult.tokenizedText;
                        if (piiResult.tokenMap && Object.keys(piiResult.tokenMap).length > 0) {
                            assistantTokenisationInfo.tokenMap = piiResult.tokenMap;
                        }
                    }
                }

                // Log PII redact event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'pii',
                    violation_categories: [...new Set(piiResult.entities.map(e => e.label || e.category))].join(', '),
                    direction: 'input',
                    action_taken: 'redacted',
                }).catch(() => {});
            }
        } catch (piiError) {
            if (piiError.message?.includes('PII Detected')) {
                log.warn('[GuardrailsRunner] PII detected in user input:', piiError.message);
                const entityLabels = piiError.piiEntities
                    ? [...new Set(piiError.piiEntities.map(e => e.label || e.category))]
                    : ['personal information'];
                const labelList = entityLabels.join(', ');

                if (onEvent) {
                    onEvent('guardrail_violation', {
                        rules: entityLabels,
                        autoDeleteSeconds: 5,
                        outcome: JSON.stringify(entityLabels.map(l => ({ label: l }))),
                        categories: entityLabels,
                        type: 'pii'
                    });
                }
                moderationViolation = `PII Detected: ${labelList}`;

                // Log PII event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'pii',
                    violation_categories: labelList,
                    direction: 'input',
                    action_taken: 'blocked',
                }).catch(() => {});
            } else if (piiError.privacyUnavailable) {
                // Detection couldn't fully run and the org policy is fail_closed —
                // block this turn instead of sending unmasked text (BFSF-269). The
                // agent path surfaces the block as a polite "try again" via
                // moderationViolation (chatStream turns it into a short reply).
                log.warn('[GuardrailsRunner] 🛑 Privacy protection unavailable — blocking (fail_closed):', piiError.degradedReason || piiError.message);
                // "Try again in a moment" is wrong advice for an oversized
                // message: the retry does the same work and fails the same way.
                // This string reaches the user through chatStream, which has no
                // request locale, so it stays English here — but it must at
                // least be TRUE. piiError.message already carries the right
                // wording from classifyDegradation.
                moderationViolation = piiError.privacyUnavailableKind === 'too_large'
                    ? 'This message is too large to scan for personal data — please split it into smaller parts'
                    : 'Privacy protection temporarily unavailable — please try again in a moment';
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'pii_unavailable',
                    violation_categories: 'privacy_protection_unavailable',
                    direction: 'input',
                    action_taken: 'blocked',
                }).catch(() => {});
            }
            // Other errors (service unavailable etc.) → fail-open, log and continue
        }
    }

    const agentRegexConfig = agent.config?.regexGuardrails;
    let regexConfig = null;
    // Reuse the shield resolved at the top of this run (org shield, or the
    // personal user shield for consumer-owned agents).
    const orgShieldConfig = orgShield;
    let agentLocalConfig = null;
    
    if (agentRegexConfig?.enabled) {
        const globalRegexConfig = globalConfig?.regexGuardrails || {};
        const globalRules = globalRegexConfig.rules || [];
        const globalCollections = globalRegexConfig.collections || [];

        let rulesWithNames = [];
        if (agentRegexConfig.collectionIds?.length > 0) {
            for (const colId of agentRegexConfig.collectionIds) {
                const collection = globalCollections.find(c => c.id === colId);
                if (collection) {
                    for (const ruleId of collection.ruleIds || []) {
                        const rule = globalRules.find(r => r.id === ruleId);
                        if (rule?.pattern) {
                            rulesWithNames.push({ name: rule.name, pattern: rule.pattern });
                        }
                    }
                }
            }
        }

        const scope = agentRegexConfig.scope || { userInput: true, agentOutput: true, toolInput: false, toolOutput: false };
        const action = agentRegexConfig.action || 'delete';
        if (rulesWithNames.length > 0) {
            agentLocalConfig = { enabled: true, rulesWithNames, scope, action };
        }
    }

    regexConfig = mergeWithOrgShield(orgShieldConfig, agentLocalConfig);

    // Regex guardrails on the user input (redact into the PII-processed copy).
    {
        const rx = applyRegexGuardrails({ text: userMessage, redactBase: processedUserMessage, regexConfig, scope: 'userInput', emit: onEvent, audit: eventCtx, direction: 'input' });
        if (rx.action === 'redact') processedUserMessage = rx.processedText;
        else if (rx.action === 'block') guardrailViolation = rx.ruleNames;
    }

    return {
        moderationViolation,
        guardrailViolation,
        processedUserMessage,
        regexConfig,
        webSearchGuardEnabled,
        disableSearchOnUpload,
        webSearchGuardPiiCategories,
        userPrivacyMeta,
        assistantTokenisationInfo,
        piiReport: {
            status: piiReport.status || 'unscanned',
            decision: piiReport.decision || null,
            categories: Array.isArray(piiReport.categories) ? piiReport.categories : [],
        },
    };
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
 * @param {Object}   p.regexConfig  Merged shield/local config ({enabled, scope, action, rulesWithNames}).
 * @param {string}   p.scope        Which scope flag to honour ('userInput' | 'agentOutput' | ...).
 * @param {Function} [p.emit]       (type, data) => void — onEvent (agent) / send (route).
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
            } catch (e) { /* skip invalid patterns */ }
        }
        emit?.('content_redact', { originalMessage: text, redactedMessage: processedText, rules: ruleNames, autoRedactSeconds: 5 });
        if (audit) {
            guardrailEventStore.logGuardrailEvent({ ...audit, violation_type: 'regex', violation_categories: ruleNames, direction, action_taken: 'redacted' }).catch(() => {});
        }
        return { action: 'redact', processedText, ruleNames };
    }

    emit?.('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
    if (audit) {
        guardrailEventStore.logGuardrailEvent({ ...audit, violation_type: 'regex', violation_categories: ruleNames, direction, action_taken: 'blocked' }).catch(() => {});
    }
    return { action: 'block', processedText: base, ruleNames };
}

module.exports = { runInputGuardrails, applyRegexGuardrails };

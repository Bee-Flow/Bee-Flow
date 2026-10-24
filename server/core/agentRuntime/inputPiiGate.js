// @typecheck
/**
 * The PII step of the agent input guardrails (./guardrailsRunner): scan the
 * last messages, tokenise the user message in place on a redact verdict, or
 * turn a block / fail-closed verdict into a `moderationViolation`.
 *
 * Single backend: the PII Guard service (GLiNER). If the guard isn't
 * installed, detectPii() returns null and the chat path fails open.
 *
 * The detector, the scan-phase status line and the DLP runner are handed in
 * as `d` ({ validateInputForPii, startPrivacyScanPhase, messageText,
 * dlpRunner() }) by ./guardrailsRunner: they sit in the server's large import
 * cycle, which this module stays out of.
 */
const guardrailEventStore = require('../../stores/guardrailEventStore');
const log = require('../../telemetry/log');

const PRIVACY_MODE_RULES = `
- Sensitive values in the user's message and retrieved memories have been replaced with placeholders like [email_1], [phone_2] or [iban_1].
- When referring to these values in your response, write the SAME placeholder verbatim. The system restores the real value for the user automatically.
- DO NOT infer, guess, describe, or reveal any property of the underlying data — no digits, no check-codes, no institution names, no country codes derived from the placeholder, no example values, no "it starts with…".
- If the user asks a question whose answer would require those inferred properties (e.g. "which bank is my IBAN from?"), answer based only on what YOU can see: placeholders. Say you cannot determine the answer from the protected data and suggest the user check directly.
- Never invent values; never reveal the token map.]`;

/**
 * Run the PII gate. Resolves to the fields it may set:
 * `{ moderationViolation, processedUserMessage, userPrivacyMeta, assistantTokenisationInfo }`
 * (each null/unchanged when the gate had nothing to say). `piiReport` is
 * filled in place (validate.js `options.report`).
 */
async function runInputPiiGate({ messages, orgShield, orgPiiEnabled, onEvent, userId, conversationId, model, eventCtx, piiReport, processedUserMessage }, d) {
    const out = { moderationViolation: null, processedUserMessage, userPrivacyMeta: null, assistantTokenisationInfo: null };
    try {
        const piiMessages = [
            ...messages.slice(-3), // last few messages for context
        ];
        // Seed the tokeniser with what this conversation has already minted.
        // Without it every turn restarts at [email_1], so turn 2's token
        // silently overwrites turn 1's mapping in the merged conversation map
        // below — and the un-tokeniser then restores the WRONG address into
        // the assistant's reply. The DLP path (dlp/dlpRunner.js) has always
        // done this; this path never did. Async so a conversation resumed
        // after a restart hydrates its map from the DB first rather than
        // starting from 1 again.
        let existingTokenMap = null;
        try {
            existingTokenMap = await d.dlpRunner().getConversationTokenMapAsync(conversationId);
        } catch (err) { log.debug('non-fatal — worst case we start fresh, as before', err); }

        // Same status line the direct-chat path shows: a big paste is scanned
        // window by window and takes minutes, and the agent path reported
        // nothing at all while it did.
        const _ps = d.startPrivacyScanPhase(onEvent, d.messageText(messages[messages.length - 1]));
        let piiResult;
        try {
            piiResult = await d.validateInputForPii(piiMessages, orgPiiEnabled, orgShield, null, existingTokenMap, { vaultUserId: userId || null, onProgress: _ps.onProgress, report: piiReport });
        } finally {
            _ps.end();
        }

        if (piiResult && piiResult.tokenizedText) {
            applyPiiTokenisation(out, { piiResult, messages, orgShield, onEvent, conversationId, model, eventCtx }, d);
        }
    } catch (piiError) {
        out.moderationViolation = piiBlockFromError(piiError, { onEvent, eventCtx });
    }
    return out;
}

/** Redact/tokenise mode: rewrite the user message, tell the model and the client, keep the persistence meta. */
function applyPiiTokenisation(out, { piiResult, messages, orgShield, onEvent, conversationId, model, eventCtx }, d) {
    // Replace the user message with the tokenized version
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
        if (typeof lastMsg.content === 'string') {
            lastMsg.content = piiResult.tokenizedText;
            out.processedUserMessage = piiResult.tokenizedText;
        } else if (Array.isArray(lastMsg.content)) {
            const textPart = lastMsg.content.find(p => p.type === 'text');
            if (textPart) {
                textPart.text = piiResult.tokenizedText;
                out.processedUserMessage = piiResult.tokenizedText;
            }
        }
    }
    log.warn(`[GuardrailsRunner] 🔒 PII redacted (${Object.keys(piiResult.tokenMap).length} tokens)`);

    // Stash the token map on the shared conversation-scoped store so
    // chatStream's un-tokeniser wrapper restores these values on the
    // response. Without this step the tokens leak through to the UI
    // whenever DLP itself is disabled.
    try {
        d.dlpRunner().mergeTokenMap(conversationId, piiResult.tokenMap);
    } catch (err) { log.debug('non-fatal — missing dlpRunner just means no restoration', err); }

    // Let the LLM know that the placeholders in the user's message are
    // redaction tokens and it should echo them back unchanged. Match the
    // format emitted by piiDetection.js → `[email_1]`, `[phone_2]`, …
    if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
        const categoryList = [...new Set(piiResult.entities.map(e => e.label || e.category))].join(', ');
        messages[0].content += `\n\n[PRIVACY MODE ACTIVE — strict rules (${categoryList}):${PRIVACY_MODE_RULES}`;
    }

    if (onEvent) emitTokenisationEvents({ piiResult, orgShield, onEvent, model });

    // Persistence accumulators returned to the caller (chatStream)
    // so the redaction badge + privacy panel survive page refreshes.
    const piiCats = [...new Set(piiResult.entities.map(e => e.label || e.category).filter(Boolean))];
    const piiCount = Object.keys(piiResult.tokenMap).length;
    out.userPrivacyMeta = { piiTokenizedCount: piiCount, piiCategories: piiCats };
    /** @type {Record<string, any>} */
    const assistantTokenisationInfo = out.assistantTokenisationInfo = {
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

    // Log PII redact event (fire-and-forget)
    guardrailEventStore.logGuardrailEvent({
        ...eventCtx,
        violation_type: 'pii',
        violation_categories: [...new Set(piiResult.entities.map(e => e.label || e.category))].join(', '),
        direction: 'input',
        action_taken: 'redacted',
    }).catch(() => {});
}

function emitTokenisationEvents({ piiResult, orgShield, onEvent, model }) {
    onEvent('pii_tokenized', {
        entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
        tokenCount: Object.keys(piiResult.tokenMap).length,
    });

    // Transparency: when the org enables `showRawPayload`, also emit the
    // exact tokenised string that's about to be sent to the LLM. The user's
    // "How I got this answer" panel uses this to show the real outbound
    // payload. Opt-in per org.
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

/**
 * A thrown PII verdict as a `moderationViolation`, or null when the error is
 * not one (service unavailable etc. → fail-open, the turn continues).
 */
function piiBlockFromError(piiError, { onEvent, eventCtx }) {
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
                type: 'pii',
            });
        }

        // Log PII event (fire-and-forget)
        guardrailEventStore.logGuardrailEvent({
            ...eventCtx,
            violation_type: 'pii',
            violation_categories: labelList,
            direction: 'input',
            action_taken: 'blocked',
        }).catch(() => {});
        return `PII Detected: ${labelList}`;
    }
    if (piiError.privacyUnavailable) {
        // Detection couldn't fully run and the org policy is fail_closed —
        // block this turn instead of sending unmasked text (BFSF-269). The
        // agent path surfaces the block as a polite "try again" via
        // moderationViolation (chatStream turns it into a short reply).
        log.warn('[GuardrailsRunner] 🛑 Privacy protection unavailable — blocking (fail_closed):', piiError.degradedReason || piiError.message);
        // "Try again in a moment" is wrong advice for an oversized message:
        // the retry does the same work and fails the same way. This string
        // reaches the user through chatStream, which has no request locale, so
        // it stays English here — but it must at least be TRUE.
        // piiError.message already carries the right wording from
        // classifyDegradation.
        const violation = piiError.privacyUnavailableKind === 'too_large'
            ? 'This message is too large to scan for personal data — please split it into smaller parts'
            : 'Privacy protection temporarily unavailable — please try again in a moment';
        guardrailEventStore.logGuardrailEvent({
            ...eventCtx,
            violation_type: 'pii_unavailable',
            violation_categories: 'privacy_protection_unavailable',
            direction: 'input',
            action_taken: 'blocked',
        }).catch(() => {});
        return violation;
    }
    // Other errors (service unavailable etc.) → fail-open, log and continue
    return null;
}

module.exports = { runInputPiiGate };

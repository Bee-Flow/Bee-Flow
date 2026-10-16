/**
 * Direct Chat input gates, part two: the PII detection gate (block or
 * tokenize, fail-closed when protection is unavailable) and the interactive
 * pre-flight DLP scanner. Split out of inputGates.js; behaviour unchanged.
 *
 * Each gate returns `{ blocked: true }` after it ended the SSE stream, or the
 * privacy state it produced for the turn.
 */

const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { buildTokenPreservationAddendum } = require('../../../core/dlp/tokenPreservationPrompt');
const { startPrivacyScanPhase, messageText } = require('../../../core/agentRuntime/phaseEvents');
const orgHealth = require('../../../services/orgHealth');
const log = require('../../../telemetry/log');

const auditInput = (g, violation_type, violation_categories, action_taken) => guardrailEventStore.logGuardrailEvent({
    organization_id: g.userOrgId || null,
    user_id: g.userId,
    conversation_id: g.convId || null,
    violation_type,
    violation_categories,
    direction: 'input',
    action_taken,
    source: 'direct',
    model: g.modelId || null,
}).catch(() => {});

/**
 * Hydrate the conversation-scoped PII token map from the DB before ANY
 * downstream code reads it. On turn 2+ the streaming un-tokeniser, the token
 * preservation addendum and the inbound-history retokeniser all consult the
 * in-process map, which is {} until hydrated; without this a `[medication_1]`
 * minted on turn 1 survives as literal text in every later reply. Idempotent.
 */
async function hydrateTokenMap(convId) {
    if (!convId) return;
    try { await require('../../../core/dlp/dlpRunner').getConversationTokenMapAsync(convId); }
    catch (_) { /* hydration is best-effort */ }
}

/** Tokenize mode found PII: swap in the tokenised text and record what happened. */
function applyPiiTokens(g, piiResult) {
    const { messages, convId, modelId, orgShield, send, appendVolatile } = g;
    const lastMsg = messages[messages.length - 1];
    if (typeof lastMsg.content === 'string') {
        lastMsg.content = piiResult.tokenizedText;
    } else if (Array.isArray(lastMsg.content)) {
        const textPart = lastMsg.content.find(p => p.type === 'text');
        if (textPart) textPart.text = piiResult.tokenizedText;
    }
    // Register on the shared DLP conversation-token store so the streaming
    // un-tokeniser restores these values on the way back even when DLP itself
    // is disabled.
    try { require('../../../core/dlp/dlpRunner').mergeTokenMap(convId, piiResult.tokenMap); } catch (_) { /* non-fatal */ }
    // Token names only, never the values they stand for.
    log.warn(`[DirectChat] 🔒 PII tokenized (${Object.keys(piiResult.tokenMap).length} tokens): ${Object.keys(piiResult.tokenMap).join(', ')}`);

    // Tell the AI about the tokenization so it can reference them properly.
    // Shared helper (also used by the agent path); reads conversation-scoped
    // tokens so a value redacted in turn 1 is still recognised in turn 5.
    try {
        const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
        appendVolatile(buildTokenPreservationAddendum(convMap));
    } catch (_) {
        appendVolatile(buildTokenPreservationAddendum(piiResult.tokenMap));
    }

    send('pii_tokenized', {
        entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
        tokenCount: Object.keys(piiResult.tokenMap).length,
    });

    // Persistence: the user message gets a redacted badge and the assistant
    // message the privacy panel after a refresh.
    const piiCats = [...new Set(piiResult.entities.map(e => e.label || e.category).filter(Boolean))];
    const piiCount = Object.keys(piiResult.tokenMap).length;
    const userPrivacyMeta = { piiTokenizedCount: piiCount, piiCategories: piiCats };
    const assistantInfo = {
        source: 'pii',
        action: 'redact',
        count: piiCount,
        categories: piiCats,
        provider: modelId || null,
        automatic: true,
    };

    // Transparency: when enabled per-org, surface the exact tokenised outbound
    // string so the user can verify what the LLM received.
    if (orgShield?.showRawPayload) {
        send('privacy_payload', {
            tokenizedPrompt: piiResult.tokenizedText,
            provider: modelId || null,
            source: 'pii',
            timestamp: Date.now(),
        });
        assistantInfo.tokenizedPrompt = piiResult.tokenizedText;
        if (piiResult.tokenMap && Object.keys(piiResult.tokenMap).length > 0) {
            send('privacy_token_map', { tokenMap: piiResult.tokenMap, source: 'pii' });
            assistantInfo.tokenMap = piiResult.tokenMap;
        }
    }

    // Log PII tokenize event (fire-and-forget)
    auditInput(g, 'pii', piiResult.entities.map(e => e.label || e.category).join(', '), 'tokenized');
    return { piiTokenMap: piiResult.tokenMap, tokenizedMessage: piiResult.tokenizedText, userPrivacyMeta, assistantInfo };
}

/** Run validateInputForPii under a "Protecting your data…" phase. */
async function detectPii(g) {
    const { messages, orgShield, userId, send, chatSignal } = g;
    const { validateInputForPii } = require('../../../core/privacy/piiDetection');
    // The org Privacy Shield's master `enabled` flag is the only switch
    // needed: detectPii() calls the PII Guard service.
    const orgPiiEnabled = !!orgShield?.enabled;
    // Shape only: never a slice of the message, which is what the shield is
    // about to protect.
    log.info(`[DirectChat] PII calling validateInputForPii: orgPiiEnabled=${orgPiiEnabled} msgCount=${messages.length} lastChars=${messageText(messages[messages.length - 1]).length}`);
    // A multi-window scan reports the part it is on, so minutes of scanning
    // never look like a hang.
    const ps = startPrivacyScanPhase(send, messageText(messages[messages.length - 1]));
    try {
        const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield, null, null, { vaultUserId: userId, onProgress: ps.onProgress, report: chatSignal ? chatSignal.pii : undefined });
        log.info(`[DirectChat] PII validateInputForPii returned: ${piiResult ? `entities=${piiResult.entities?.length ?? 'n/a'} tokenized=${!!piiResult.tokenizedText}` : 'null'}`);
        return piiResult;
    } catch (innerErr) {
        log.error(`[DirectChat] PII INNER ERROR: ${innerErr.message}\n${innerErr.stack}`);
        throw innerErr;
    } finally {
        ps.end();
    }
}

/** A PII gate error: block (fail-closed or block mode, stream ended) or fail-open. */
function handlePiiError(g, piiError) {
    const { send, res } = g;
    if (piiError.privacyUnavailable) {
        // Detection couldn't fully run and the org policy is fail_closed:
        // block rather than send unmasked text to the LLM (BFSF-269).
        log.warn(`[DirectChat] 🛑 Privacy protection unavailable (${piiError.degradedReason || 'degraded'}) — blocking (fail_closed)`);
        // `kind` tells a transient failure ("try again") from an oversized
        // message ("split it up"): only one of them is worth retrying.
        send('dlp_blocked', {
            reason: 'pii_unavailable',
            kind: piiError.privacyUnavailableKind || 'unavailable',
            message: piiError.message,
        });
        auditInput(g, 'pii_unavailable', 'privacy_protection_unavailable', 'blocked');
        send('done', {});
        res.end();
        return { blocked: true };
    }
    if (piiError.piiEntities) {
        // Block mode: reject the message
        const categoryList = [...new Set(piiError.piiEntities.map(e => e.label))].join(', ');
        // Categories and a count: the entity texts are the blocked PII.
        log.warn(`[DirectChat] 🚫 PII blocked | categories: ${categoryList} | ${piiError.piiEntities.length} entities`);
        send('guardrail_violation', {
            rules: [categoryList],
            type: 'pii',
            piiEntities: piiError.piiEntities,
            autoDeleteSeconds: 5,
        });
        auditInput(g, 'pii', categoryList, 'blocked');
        send('done', {});
        res.end();
        return { blocked: true };
    }
    // PII service unavailable: fail-open, log and continue
    log.warn('[DirectChat] PII check error (fail-open):', piiError.message);
    return {};
}

/**
 * PII detection, independent of content moderation. Action 'block' rejects
 * the message; 'tokenize' replaces PII spans with tokens, passes clean text
 * to the AI and restores tokens in the response. When the org has the
 * interactive DLP gate enabled, this auto-tokenising path is skipped: the
 * DLP pre-flight handles scan + user decision + audit.
 */
async function runPiiGate(g) {
    const { convId, orgShield, shieldSource } = g;
    const dlpWillHandleHere = !!(orgShield?.enabled && orgShield?.dlpEnabled);
    if (dlpWillHandleHere) {
        log.info('[DirectChat] DLP enabled — deferring PII handling to pre-flight DLP gate');
    }
    // Diagnostic on every turn, so support can correlate to a convId.
    log.info(`[DirectChat] PII gate: convId=${convId} shield=${orgShield ? 'present' : 'NULL'} source=${shieldSource} enabled=${orgShield?.enabled} action=${orgShield?.piiDetectionAction || 'default'} dlpWillHandleHere=${dlpWillHandleHere}`);
    await hydrateTokenMap(convId);
    if (dlpWillHandleHere) return {};
    try {
        const piiResult = await detectPii(g);
        if (piiResult && piiResult.tokenizedText) return applyPiiTokens(g, piiResult);
        return {};
    } catch (piiError) {
        return handlePiiError(g, piiError);
    }
}

/** The interactive outbound DLP scanner. `orgShield` is already the resolved shape. */
async function runDlpGate(g) {
    const { req, send, res, messages, orgShield, userOrgId, convId, userId, modelId, hasAttachments, config, chatSignal, appendVolatile } = g;
    const { runDlpPreflight } = require('../../../core/dlp/dlpPreflight');
    const dlp = await runDlpPreflight({
        messages,
        resolvedShield: orgShield,
        orgId: userOrgId,
        conversationId: convId,
        userId,
        model: modelId || null,
        // See the equivalent comment in chatStream.js: attachments in this
        // turn already got their own ask-review earlier
        // (processAttachmentsAndUserMessage runs BEFORE this gate in direct
        // chat), so the message-only zero-finding dlpAlwaysReview pause would
        // just be a second, near-empty popup right after that one.
        hasAttachments,
        providerConfig: {
            providerType: config.providerType,
            url: config.url,
            displayName: config.providerName || config.providerType || 'LLM',
        },
        emit: (type, data) => send(type, data),
        audit: {
            organization_id: userOrgId || null,
            user_id: userId,
            model: modelId || null,
            source: 'direct',
        },
    });
    if (chatSignal) chatSignal.dlp = { outcome: dlp.outcome, scanStatus: dlp.scanStatus, categories: Array.isArray(dlp.categories) ? dlp.categories : [], override: dlp.override === true, tooShort: dlp.tooShort === true };
    if (dlp.blocked) {
        // Metadata only: outcome/policy, never the scanned content.
        orgHealth.problem('chat.dlp_blocked', {
            orgId: userOrgId || null, source: 'directChat', req,
            meta: { outcome: dlp.outcome || 'blocked', reason: dlp.outcome || 'blocked' },
        });
        // The route ends the stream cleanly (no thrown error), the same
        // response shape for policy / user / timeout blocks.
        send('done', {}); res.end();
        return { blocked: true };
    }
    const out = {};
    if (dlp.outcome === 'redacted') {
        out.piiTokenMap = dlp.tokenMap; // reuse the existing un-tokenise path on the response
        // Tell the AI about the tokens so it reuses placeholders verbatim (and
        // never invents `[your name]` for sign-offs).
        const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
        appendVolatile(buildTokenPreservationAddendum(convMap));
    }
    if (dlp.userPrivacyMeta) out.userPrivacyMeta = dlp.userPrivacyMeta;
    if (dlp.assistantTokenisationInfo) out.assistantInfo = dlp.assistantTokenisationInfo;
    return out;
}

module.exports = { runPiiGate, runDlpGate };

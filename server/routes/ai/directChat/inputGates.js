/**
 * Direct Chat — the inbound safety gates that run between prompt assembly and
 * the LLM call: Unicode-smuggling defense, org/user Privacy Shield resolution
 * (incl. the super-admin sole-org fallback), the PII detection gate
 * (block/tokenize), the interactive pre-flight DLP scanner and the regex
 * guardrails on user input. Moved verbatim out of streamTurn.js.
 *
 * Returns the resolved shield/moderation/PII state — or undefined when a gate
 * blocked the turn, in which case the SSE stream has already been ended and
 * the caller must stop.
 */

const configStore = require('../../../stores/configStore');
const { getAIConfig } = require('../../../core/aiAgent');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { buildTokenPreservationAddendum } = require('../../../core/dlp/tokenPreservationPrompt');
const { startPrivacyScanPhase, messageText } = require('../../../core/agentRuntime/phaseEvents');
const { applyRegexGuardrails } = require('../../../core/agentRuntime/guardrailsRunner');
const orgHealth = require('../../../services/orgHealth');
const log = require('../../../telemetry/log');

async function runInputGates({ req, res, send, userId, convId, message, messages, modelId, config, hasAttachments = false, volatileMessage = null }) {
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
        // ─── Unicode Smuggling Defense ───────────────────────────────
        // Must run FIRST — before moderation, PII, and regex guardrails.
        // Strips hidden payloads encoded via Variation Selectors / Tags block.
        const { sanitizeMessagesUnicode } = require('../../../utils/unicodeSanitizer');
        const unicodeResult = sanitizeMessagesUnicode(messages);
        if (unicodeResult.smugglingDetected) {
            log.warn(`[DirectChat] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
            send('unicode_smuggling_detected', {
                strippedCount: unicodeResult.totalStripped,
                messageIndices: unicodeResult.detectedIn,
            });
        }

        // ─── AI Content Moderation (org shield) ─────────────────────
        const { resolveUserOrgIds } = require('../../../auth');
        const userOrgIds = await resolveUserOrgIds(req);
        // Super-admins get `null` from resolveUserOrgIds (intentional — it
        // bypasses org-scoped filtering for read queries). For shield/PII
        // resolution we still want their actual org binding so the shield
        // is loaded; fall back to session.user.organizationId.
        const userOrgId = (userOrgIds && userOrgIds.size > 0)
            ? Array.from(userOrgIds)[0]
            : (req.session?.user?.organizationId || null);

        // Deferred log for unicode smuggling (needed userOrgId)
        if (unicodeResult.smugglingDetected) {
            guardrailEventStore.logGuardrailEvent({
                organization_id: userOrgId || null,
                user_id: userId,
                conversation_id: convId || null,
                violation_type: 'unicode_smuggling',
                violation_categories: `${unicodeResult.totalStripped} hidden chars`,
                direction: 'input',
                action_taken: 'stripped',
                source: 'direct',
                model: modelId || null,
            }).catch(() => {});
        }

        // Check if org shield or global config enables moderation for direct chat
        let moderationViolation = null;
        // Privacy / DLP metadata accumulators — attached to the saved user/assistant
        // messages just before persistence so the redaction badge and "How I got this
        // answer" panel survive a page refresh.
        let _userPrivacyMeta = null;
        let _assistantTokenisationInfo = null;
        // Resolve the Privacy Shield for this turn. Org-bound users get their
        // org shield; consumer accounts (no org) fall back to their own
        // user-level shield from the personal Privacy Shield settings — the
        // attachment scanner above already does this, and reading only the org
        // key here meant typed text went to the model unprotected on personal
        // accounts while their PDFs were redacted (BFSF-290 / BFSF-291).
        //
        // Super-admin edge case: req.session.isAdmin users may have no
        // organizationId binding at all (organizationId === '' on the admin
        // seed account). They still chat through this route, and need the
        // shield to apply — otherwise PII detection / moderation / web
        // search guard all silently no-op for the highest-privilege user.
        // Fall back to the single org shield when exactly one exists; with
        // multiple orgs we don't guess (would need a UI "act as org" picker).
        const { resolveShieldFor, mergeWithOrgShield } = require('../../../core/privacy/orgShield');
        let orgShield = await resolveShieldFor({ orgId: userOrgId, userId });
        let shieldSource = orgShield ? (userOrgId ? `org ${userOrgId}` : `user ${userId}`) : 'none';
        if (!orgShield?.enabled && req.session?.isAdmin) {
            const allConfigs = await configStore.getAllConfig() || {};
            const shieldKeys = Object.keys(allConfigs).filter(k => k.startsWith('org_privacy_shield_'));
            if (shieldKeys.length === 1) {
                // Resolve it properly (tier clamps + legacy field mapping) rather
                // than handing the raw stored doc downstream.
                const soleOrgId = shieldKeys[0].replace(/^org_privacy_shield_/, '');
                const { resolveOrgShield } = require('../../../core/privacy/orgShield');
                orgShield = await resolveOrgShield(soleOrgId) || allConfigs[shieldKeys[0]];
                shieldSource = `sole-org ${soleOrgId} (super-admin)`;
                log.info(`[DirectChat] Super-admin without org binding — using sole org shield ${shieldKeys[0]}`);
            } else if (shieldKeys.length > 1) {
                log.info(`[DirectChat] Super-admin without org binding and ${shieldKeys.length} shields exist — no shield applied (set organizationId on the admin user or add an org picker)`);
            }
        }
        const webSearchGuardEnabled = !!(orgShield?.enabled && orgShield?.webSearchGuardEnabled);

        // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed when
        // the Azure Content Safety backend was dropped. PII detection still
        // runs further below.

        // Inject moderation violation context into the volatile block so AI can explain
        if (moderationViolation) {
            appendVolatile(`\n\n[IMPORTANT: The user's message was flagged by our content safety policy. You must briefly explain that their message could not be processed because it was flagged by our content policy, and politely ask them to rephrase. Keep your response short (1-2 sentences). Do not reveal the specific violation category. Do not process or answer the original request.]`);
            // Strip the violating user message — only send a placeholder to the model
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === 'user') {
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = `[Message flagged by content moderation]`;
                } else if (Array.isArray(lastMsg.content)) {
                    // Multimodal message — replace only text parts, keep structure
                    lastMsg.content = lastMsg.content.map(part =>
                        part.type === 'text' ? { type: 'text', text: '[Message flagged by content moderation]' } : part
                    );
                }
            }
        }

        // ─── PII Detection (independent of content moderation) ──────
        // Runs whenever piiDetectionEnabled is true, regardless of moderation settings.
        // Action 'block' — throw and reject message.
        // Action 'tokenize' — replace PII spans with tokens, pass clean text to AI,
        //                     restore tokens in the AI response before showing the user.
        // When the org has the interactive DLP gate enabled, skip this auto-tokenising
        // path — the DLP block further down handles scan + user decision + audit.
        let piiTokenMap = null;  // non-null only in tokenize mode when PII found
        // Mirror of `message` for non-LLM consumers (DB persistence, memory
        // extraction, title generator). When PII tokenisation fires, this
        // becomes the redacted form so downstream code never sees raw PII —
        // the original `message` const is only used to fork into the LLM's
        // `messages[]` array and isn't trustworthy after tokenisation.
        let tokenizedMessage = message;
        const dlpWillHandleHere = !!(orgShield?.enabled && orgShield?.dlpEnabled);
        if (dlpWillHandleHere) {
            log.info('[DirectChat] DLP enabled — deferring PII handling to pre-flight DLP gate');
        }
        // Diagnostic: show why PII block may skip (orgShield may be null on
        // some paths — e.g. when userOrgId is not yet resolved). Print on
        // every turn so support can correlate to a specific convId.
        log.info(`[DirectChat] PII gate: convId=${convId} shield=${orgShield ? 'present' : 'NULL'} source=${shieldSource} enabled=${orgShield?.enabled} action=${orgShield?.piiDetectionAction || 'default'} dlpWillHandleHere=${dlpWillHandleHere}`);
        // Hydrate the conversation-scoped PII token map from the DB before
        // ANY downstream code reads it. Required for multi-turn correctness:
        // on turn 2+, the streaming un-tokeniser, the system-prompt token
        // preservation addendum, and the inbound-history retokeniser all
        // consult the in-process map via getConversationTokenMap(), which
        // returns {} when the map hasn't been hydrated. Without this, a
        // `[medication_1]` minted on turn 1 survives as literal text in
        // every later assistant reply. Idempotent — populates the in-process
        // Map only when it's currently empty.
        if (convId) {
            try { await require('../../../core/dlp/dlpRunner').getConversationTokenMapAsync(convId); }
            catch (_) { /* hydration is best-effort */ }
        }
        try {
            if (dlpWillHandleHere) throw { __skip: true };
            const { validateInputForPii } = require('../../../core/privacy/piiDetection');
            // The org Privacy Shield's master `enabled` flag is the only
            // switch needed — detectPii() calls the PII Guard service.
            const orgPiiEnabled = !!orgShield?.enabled;
            // Shape only: never a slice of the message, which is what the
            // shield is about to protect.
            log.info(`[DirectChat] PII calling validateInputForPii: orgPiiEnabled=${orgPiiEnabled} msgCount=${messages.length} lastChars=${messageText(messages[messages.length - 1]).length}`);
            // Show a "Protecting your data…" status while the (possibly slow,
            // for a big pasted document) PII scan runs, instead of a silent
            // "Thinking…". A multi-window scan reports the part it is on, so
            // minutes of scanning never look like a hang.
            const _ps = startPrivacyScanPhase(send, messageText(messages[messages.length - 1]));
            let piiResult;
            try {
                piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield, null, null, { vaultUserId: userId, onProgress: _ps.onProgress });
                log.info(`[DirectChat] PII validateInputForPii returned: ${piiResult ? `entities=${piiResult.entities?.length ?? 'n/a'} tokenized=${!!piiResult.tokenizedText}` : 'null'}`);
            } catch (innerErr) {
                log.error(`[DirectChat] PII INNER ERROR: ${innerErr.message}\n${innerErr.stack}`);
                throw innerErr;
            } finally {
                _ps.end();
            }

            if (piiResult && piiResult.tokenizedText) {
                // Tokenize mode: replace last user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = piiResult.tokenizedText;
                } else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = piiResult.tokenizedText;
                }
                piiTokenMap = piiResult.tokenMap;
                tokenizedMessage = piiResult.tokenizedText;
                // Register on the shared DLP conversation-token store so the streaming
                // un-tokeniser restores these values on the way back even when DLP
                // itself is disabled.
                try { require('../../../core/dlp/dlpRunner').mergeTokenMap(convId, piiResult.tokenMap); } catch (_) { /* non-fatal */ }
                // Token names only, never the values they stand for.
                log.warn(`[DirectChat] 🔒 PII tokenized (${Object.keys(piiResult.tokenMap).length} tokens): ${Object.keys(piiResult.tokenMap).join(', ')}`);

                // Tell the AI about the tokenization so it can reference them properly.
                // Shared helper — also used by the agent path — keeps the rules and
                // sign-off guidance in one place. Reads conversation-scoped tokens so
                // a value redacted in turn 1 is still recognised in turn 5.
                try {
                    const _convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                    appendVolatile(buildTokenPreservationAddendum(_convMap));
                } catch (_) {
                    appendVolatile(buildTokenPreservationAddendum(piiResult.tokenMap));
                }

                send('pii_tokenized', {
                    entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
                    tokenCount: Object.keys(piiResult.tokenMap).length,
                });

                // Persistence: stash the same data on the request-scoped accumulators
                // so the user message gets a redacted badge and the assistant message
                // gets the privacy panel after a refresh.
                {
                    const piiCats = [...new Set(piiResult.entities.map(e => e.label || e.category).filter(Boolean))];
                    const piiCount = Object.keys(piiResult.tokenMap).length;
                    _userPrivacyMeta = { piiTokenizedCount: piiCount, piiCategories: piiCats };
                    _assistantTokenisationInfo = {
                        source: 'pii',
                        action: 'redact',
                        count: piiCount,
                        categories: piiCats,
                        provider: modelId || null,
                        automatic: true,
                    };
                }

                // Transparency: when enabled per-org, surface the exact tokenised
                // outbound string so the user can verify what the LLM received.
                if (orgShield?.showRawPayload) {
                    send('privacy_payload', {
                        tokenizedPrompt: piiResult.tokenizedText,
                        provider: modelId || null,
                        source: 'pii',
                        timestamp: Date.now(),
                    });
                    if (_assistantTokenisationInfo) _assistantTokenisationInfo.tokenizedPrompt = piiResult.tokenizedText;
                    if (piiResult.tokenMap && Object.keys(piiResult.tokenMap).length > 0) {
                        send('privacy_token_map', { tokenMap: piiResult.tokenMap, source: 'pii' });
                        if (_assistantTokenisationInfo) _assistantTokenisationInfo.tokenMap = piiResult.tokenMap;
                    }
                }

                // Log PII tokenize event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    organization_id: userOrgId || null,
                    user_id: userId,
                    conversation_id: convId || null,
                    violation_type: 'pii',
                    violation_categories: piiResult.entities.map(e => e.label || e.category).join(', '),
                    direction: 'input',
                    action_taken: 'tokenized',
                    source: 'direct',
                    model: modelId || null,
                }).catch(() => {});
            }
        } catch (piiError) {
            if (piiError?.__skip) {
                // DLP gate will handle PII; nothing to do here.
            } else if (piiError.privacyUnavailable) {
                // Detection couldn't fully run and the org policy is fail_closed:
                // block rather than send unmasked text to the LLM (BFSF-269).
                log.warn(`[DirectChat] 🛑 Privacy protection unavailable (${piiError.degradedReason || 'degraded'}) — blocking (fail_closed)`);
                // `kind` distinguishes a transient failure ("try again") from an
                // oversized message ("split it up"). Both block; only one of
                // them is worth retrying, and telling a user to retry something
                // that cannot succeed is worse than saying nothing.
                send('dlp_blocked', {
                    reason: 'pii_unavailable',
                    kind: piiError.privacyUnavailableKind || 'unavailable',
                    message: piiError.message,
                });
                guardrailEventStore.logGuardrailEvent({
                    organization_id: userOrgId || null,
                    user_id: userId,
                    conversation_id: convId || null,
                    violation_type: 'pii_unavailable',
                    violation_categories: 'privacy_protection_unavailable',
                    direction: 'input',
                    action_taken: 'blocked',
                    source: 'direct',
                    model: modelId || null,
                }).catch(() => {});
                send('done', {});
                res.end();
                return;
            } else if (piiError.piiEntities) {
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

                // Log PII block event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    organization_id: userOrgId || null,
                    user_id: userId,
                    conversation_id: convId || null,
                    violation_type: 'pii',
                    violation_categories: categoryList,
                    direction: 'input',
                    action_taken: 'blocked',
                    source: 'direct',
                    model: modelId || null,
                }).catch(() => {});

                send('done', {});
                res.end();
                return;
            }
            // PII service unavailable — fail-open, log and continue
            log.warn('[DirectChat] PII check error (fail-open):', piiError.message);
        }

        // ─── Pre-flight DLP (interactive outbound scanner) ───────────
        if (orgShield?.enabled && orgShield?.dlpEnabled) {
            // `orgShield` is already the resolved shape — no second resolve needed.
            const { runDlpPreflight } = require('../../../core/dlp/dlpPreflight');
            const dlp = await runDlpPreflight({
                messages,
                resolvedShield: orgShield,
                orgId: userOrgId,
                conversationId: convId,
                userId,
                model: modelId || null,
                // See the equivalent comment in chatStream.js — attachments in
                // this turn already got their own ask-review earlier
                // (processAttachmentsAndUserMessage, which runs BEFORE this
                // gate in direct chat), so the message-only zero-finding
                // dlpAlwaysReview pause would just be a second, near-empty
                // popup right after that one.
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
            if (dlp.blocked) {
                // Metadata only — outcome/policy, never the scanned content.
                orgHealth.problem('chat.dlp_blocked', {
                    orgId: userOrgId || null, source: 'directChat', req,
                    meta: { outcome: dlp.outcome || 'blocked', reason: dlp.outcome || 'blocked' },
                });
                // Route path ends the stream cleanly (no thrown error) — same
                // response shape for policy / user / timeout blocks as before.
                send('done', {}); res.end(); return;
            }
            if (dlp.outcome === 'redacted') {
                piiTokenMap = dlp.tokenMap; // reuse existing un-tokenise path on the response
                // Tell the AI about the tokens so it reuses placeholders verbatim
                // (and never invents `[jouw naam]` / `[your name]` for sign-offs).
                {
                    const _convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                    appendVolatile(buildTokenPreservationAddendum(_convMap));
                }
            }
            if (dlp.userPrivacyMeta) _userPrivacyMeta = dlp.userPrivacyMeta;
            if (dlp.assistantTokenisationInfo) _assistantTokenisationInfo = dlp.assistantTokenisationInfo;
        }

        // ─── Regex Guardrails ────────────────────────────────────────
        // 1. Reuse the shield resolved at the top of the turn (org shield for
        //    org-bound users, personal user shield for consumer accounts).
        const orgShieldConfig = orgShield;
        if (orgShieldConfig) {
            log.info(`[DirectChat] Privacy Shield active for ${shieldSource} (${orgShieldConfig.rulesWithNames?.length || 0} rules)`);
        }

        // 2. Resolve direct-chat-specific regex guardrails
        const dcRegexConfig = await configStore.getConfig('direct_chat_regex_guardrails');
        let dcLocalConfig = null;

        if (dcRegexConfig?.enabled) {
            const globalConfig = await getAIConfig();
            const globalRegexConfig = globalConfig.regexGuardrails || {};
            const globalRules = globalRegexConfig.rules || [];
            const globalCollections = globalRegexConfig.collections || [];

            let rulesWithNames = [];
            if (dcRegexConfig.collectionIds?.length > 0) {
                for (const colId of dcRegexConfig.collectionIds) {
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

            const scope = dcRegexConfig.scope || { userInput: true, agentOutput: true };
            const action = dcRegexConfig.action || 'delete';
            if (rulesWithNames.length > 0) {
                dcLocalConfig = { enabled: true, rulesWithNames, scope, action };
            }
        }

        // 3. Merge: org shield + direct chat guardrails
        let regexConfig = mergeWithOrgShield(orgShieldConfig, dcLocalConfig);

        // Check user input against regex rules. Match on the typed message,
        // but redact what the model will actually receive: the PII gate or
        // the DLP pre-flight above may already have tokenised the last
        // message, and redacting the raw `message` would write the original
        // values back over those tokens (the agent path does the same with
        // redactBase: processedUserMessage).
        const lastMsg = messages[messages.length - 1];
        const textPart = Array.isArray(lastMsg?.content) ? lastMsg.content.find(p => p.type === 'text') : null;
        const redactBase = typeof lastMsg?.content === 'string' ? lastMsg.content : (textPart ? textPart.text : message);
        const inputRx = applyRegexGuardrails({ text: message, redactBase, regexConfig, scope: 'userInput', emit: send, direction: 'input' });
        if (inputRx.action !== 'pass') {
            log.info(`[DirectChat RegexGuard] User input violated rules: ${inputRx.ruleNames}, action: ${regexConfig.action}`);
        }
        if (inputRx.action === 'redact') {
            if (typeof lastMsg.content === 'string') {
                lastMsg.content = inputRx.processedText;
            } else if (textPart) {
                textPart.text = inputRx.processedText;
            }
        } else if (inputRx.action === 'block') {
            send('done', {});
            res.end();
            return;
        }
        return { userOrgId, moderationViolation, _userPrivacyMeta, _assistantTokenisationInfo, orgShield, webSearchGuardEnabled, piiTokenMap, tokenizedMessage, regexConfig };
}

module.exports = { runInputGates };

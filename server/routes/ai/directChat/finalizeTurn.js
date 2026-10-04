/**
 * Direct Chat — end-of-turn finalization after the streamed rounds are done:
 * untokeniser flush + display-segment join, the empty-response guard with the
 * Claude no-thinking auto-retry, PII token restoration for display, the regex
 * guard on agent output, conversation persistence (user + assistant rows with
 * privacy metadata, media, drafts, tool history, session-skill snapshots and
 * meta), the shared-thread feed event, title generation and the background
 * memory extraction. Moved verbatim out of streamTurn.js.
 *
 * `clearInterruptedTurnHook` bridges the handler-scoped interrupted-turn hook
 * (a `let` the route's outer catch reads): once the turn is durably recorded
 * it must be cleared on the CALLER's binding, so the caller passes a setter.
 *
 * No request schema lives here: this file declares no route. The one body value
 * it reads, `memoryWriteEnabled`, arrives through POST /chat/direct/stream
 * (streamTurn.js) and is typed by that route's schema (./turnSchema.js).
 */

const agentStore = require('../../../stores/agentStore');
const configStore = require('../../../stores/configStore');
const { getProviderForModel } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const { checkRegexPatterns } = require('../../../core/privacy/guardrails');
const { applyTokenMapToMessages } = require('../../../core/dlp/applyTokenMapToOutbound');
const { buildTitleTranscript, encryptionOpts, emitThreadEvent } = require('./shared');
const log = require('../../../telemetry/log');

/**
 * `turn` is the TurnState (./turnState.js) that every phase of this turn
 * shares. It is destructured once, here, so the body below stayed exactly
 * what it was when it lived in the route handler.
 */
async function finalizeDirectChatTurn(turn) {
    let {
        req, send, userId, convId, modelTier, resolvedTier, history, validProjectId, extractMemoriesEnabled, usableKbIds, userOrgForTiers,
        moderationViolation, tokenizedMessage, persistedAttachments, _userPrivacyMeta, piiTokenMap, _turnAttachmentSummaries,
        _assistantTokenisationInfo, _streamUntok, orgShield, regexConfig,
        fullContent, thinkingContent, thinkingParts, toolCallRounds, notebookWriteCommitted, collectedToolHistory,
        generatedImages, generatedAudio, generatedFiles = [], collectedEmailDrafts, collectedCalendarDrafts, collectedMapEmbeds,
        streamContentFlush, displaySegments,
        bootstrappedSessionSkills, sessionSkills, activatedSessionSkillIds, completedSessionSkillIds, sessionSkillsCompletions,
        lastResponseId, conversationSummary, _loadedSummary, conversationSummaryUpTo, isStandardTier,
        activatedToolGroups, activatedLibrarySkillIds, _sharedThread, tiers,
        modelId, adapter, apiKey, apiUrl, config, chatOptions, messages,
        clearInterruptedTurnHook,
    } = turn;
        // Release any tail held by the streaming un-tokeniser. The end-of-
        // stream `restoreTokens` below also fires a full `content_replace`
        // as a final safety net, but flushing here means a stable token
        // sitting at the very end of the stream gets replaced via the live
        // content channel rather than waiting for the replace.
        try { streamContentFlush(); } catch (_) { /* best-effort */ }

        // BFSF-261: make persistence match the live view — join the earlier
        // rounds' preamble text with the final round. Everything downstream
        // (empty-check, raw-payload capture, PII restore/content_replace,
        // regex guard, save) reads the joined content. The MODEL-facing
        // intermediate history messages above are untouched.
        if (displaySegments.hasSegments()) {
            fullContent = displaySegments.joinFinal(fullContent);
        }

        // If LLM returned an empty response after tool calls, send a minimal confirmation
        if (!fullContent.trim() && toolCallRounds > 0) {
            fullContent = 'Done ✓';
            send('content', { text: fullContent });
        }

        // Transparency: emit the raw (pre-un-tokenise) response once per turn
        // when the org has `showRawPayload` on. Capture BEFORE restoreTokens
        // runs so the user can see the exact string the LLM produced. Capped
        // at 64 KB with ellipsis truncation. Gated strictly by org opt-in.
        if (orgShield?.showRawPayload && fullContent) {
            const RAW_BUFFER_MAX = 64 * 1024;
            const truncated = fullContent.length > RAW_BUFFER_MAX;
            const rawForClient = truncated ? fullContent.slice(0, RAW_BUFFER_MAX) + '…' : fullContent;
            send('privacy_response_raw', {
                rawResponse: rawForClient,
                truncated,
                timestamp: Date.now(),
            });
            if (_assistantTokenisationInfo) {
                _assistantTokenisationInfo.rawResponse = rawForClient;
                _assistantTokenisationInfo.rawTruncated = truncated;
            }
        }

        // ─── PII Token Restoration ──────────────────────────────────
        // Restore tokens for the USER-FACING display channel only. The stored
        // `fullContent` MUST stay tokenised so the next turn's history (fed
        // back to the model) does not contain real PII. Without this split,
        // an adversarial follow-up such as "spell each email character by
        // character" would let Claude reformat real values it should never
        // have seen — bypassing the un-tokeniser regex match.
        // `displayContent` is used for: SSE content_replace, regex agent-
        // output check, memory extraction, title generation.
        let displayContent = fullContent;
        if (fullContent) {
            const { restoreTokens } = require('../../../core/privacy/piiDetection');
            const dlpRunner = require('../../../core/dlp/dlpRunner');
            const convMap = dlpRunner.getConversationTokenMap(convId) || {};
            const mergedMap = { ...convMap, ...(piiTokenMap || {}) };
            if (Object.keys(mergedMap).length > 0) {
                const restored = restoreTokens(fullContent, mergedMap);
                if (restored !== fullContent) {
                    log.info(`[DirectChat] 🔓 PII tokens restored for display (${Object.keys(mergedMap).length} tokens in scope, ${fullContent.length}→${restored.length} chars); storage stays tokenised`);
                    send('content_replace', { text: restored });
                    displayContent = restored;
                }
            }
        }

        // Check agent output against regex rules. Run against `displayContent`
        // (un-tokenised) — regex patterns are designed to match real values
        // like emails, phone numbers, IBANs, etc.; matching tokens would be
        // accidentally narrow. Redactions still update `fullContent` (storage)
        // so the next turn doesn't replay leaked content.
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput && displayContent) {
            const matches = checkRegexPatterns(displayContent, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                log.info(`[DirectChat RegexGuard] Agent output violated rules: ${ruleNames}`);
                if (regexConfig.action === 'redact') {
                    let redacted = displayContent;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redacted = redacted.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip */ }
                    }
                    send('content_replace', { text: redacted });
                    displayContent = redacted;
                    fullContent = redacted; // redaction is destructive — replace storage too
                } else {
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5, source: 'agent_output' });
                }
            }
        }

        // Content moderation on agent output was removed when the Azure
        // Content Safety backend was dropped. PII detection still runs on
        // the user input above; output is streamed through `untokeniseStream`
        // which restores PII tokens to real values for display.

        // ─── Conversation persistence ────────────────────────────
        //
        // ATTACHED KNOWLEDGE BASES. What is stored is `usableKbIds` — the ids
        // promptAssembly ran through kbVisibility + usage_contexts — never the
        // raw list the client named. So the column is by construction a subset
        // of what this person was authorised to search at the moment it was
        // written, and a guessed uuid can never land in it.
        //
        // It is rewritten on EVERY turn, including to `[]`. Absent or empty on
        // the request means NO knowledge bases here exactly as it does at
        // retrieval: today's clients omit the key when nothing is ticked, and
        // "leave the stored list alone" would leave a picker showing bases the
        // answer did not use — a pill that lies. The stored list is "what the
        // last turn actually searched", and that is the only claim it makes.
        const attachedKbIds = Array.isArray(usableKbIds) ? usableKbIds : [];
        if (!convId) {
            const conv = await agentStore.createDirectConversation(userId, modelTier || 'fast', attachedKbIds);
            convId = conv.id;
            send('conversation_created', { conversationId: convId });
            // Assign to the project — only one we validated the caller belongs to.
            // Stamping a conversation with an arbitrary project id was a one-way
            // door: unassigning goes through PUT /:id/conversations, which requires
            // editor on that project, so a mis-stamped chat could never be cleaned up.
            if (validProjectId) {
                try {
                    const projectStore = require('../../../stores/projectStore');
                    await projectStore.assignConversation(convId, validProjectId, userId, 'direct_conversations');
                } catch (e) {
                    log.warn('[DirectChat] Failed to assign conversation to project:', e.message);
                }
            }
        } else {
            // Owner-scoped inside the store (`AND user_id = $n`): a project
            // EDITOR posting into somebody else's shared thread does NOT get to
            // rewrite the owner's attachment list — same canManage line the
            // workspace draws. Their write matches no row and returns false,
            // which is the safe direction and is not an error.
            try {
                await agentStore.setDirectConversationKnowledgeBases(convId, attachedKbIds, userId);
            } catch (kbErr) {
                log.warn('[DirectChat] Failed to persist attached knowledge bases:', kbErr.message);
            }
        }

        // ─── Empty-response guard + Claude auto-retry ────────────────
        // When the model emits only tool calls, `fullContent` is an empty
        // string. Saving an empty assistant bubble cascades into title-gen
        // 400s and a confusing "Error generating response" in the chat UI.
        //
        // Special case for Claude adaptive thinking (Sonnet 4.6 / Opus 4.7):
        // thinking and output share the same max_tokens pot. A heavy turn
        // can consume the whole budget on thinking and finish with empty
        // text. If we already have thinking content, do ONE follow-up
        // non-streaming call without thinking — the model writes a real
        // answer based on what it already deliberated. Admin-disable via
        // the `claude_settings.autoRetryOnEmpty` config key.
        if (!fullContent || !fullContent.trim()) {
            let _retryRecovered = false;
            const _isClaude = /claude/i.test(modelId) || config.providerType === 'claude';
            if (_isClaude && thinkingContent && thinkingContent.trim()) {
                let _autoRetryEnabled = true;
                try {
                    const _cs = await configStore.getConfig('claude_settings');
                    if (_cs && _cs.autoRetryOnEmpty === false) _autoRetryEnabled = false;
                } catch (_) { /* default true */ }
                if (_autoRetryEnabled) {
                    try {
                        log.info('[DirectChat] Empty content with thinking — auto-retrying without thinking');
                        send('phase', { type: 'auto_retry_no_thinking' });
                        const _retryRes = await adapter.chat(apiKey, apiUrl, modelId,
                            applyTokenMapToMessages({ conversationId: convId, messages }),
                            {
                                ...chatOptions,
                                reasoningEffort: 'none',
                                tools: undefined,
                                toolChoice: undefined,
                                maxTokens: Math.min(chatOptions.maxTokens || 8192, 8192),
                            }
                        );
                        const _retryText = _retryRes?.content;
                        if (_retryText && _retryText.trim()) {
                            fullContent = _retryText;
                            displayContent = _retryText;
                            try { send('content_replace', { text: _retryText }); } catch (_) { /* ignore */ }
                            _retryRecovered = true;
                            log.info(`[DirectChat] Auto-retry recovered ${_retryText.length} chars`);
                        }
                    } catch (e) {
                        log.warn(`[DirectChat] Auto-retry failed: ${e.message}`);
                    }
                }
            }
            if (!_retryRecovered) {
                const fallbackText = notebookWriteCommitted
                    ? 'I wrote the answer to your Notebook — open the Notebook panel to view it.'
                    : 'The model returned no response. Please try rephrasing your question.';
                log.warn(`[DirectChat] Empty assistant content (toolsUsed=${collectedToolHistory.length > 0}, notebookWriteCommitted=${notebookWriteCommitted}) — surfacing fallback line.`);
                try { send('content_replace', { text: fallbackText }); } catch (_) { /* SSE may be closing */ }
                fullContent = fallbackText;
                displayContent = fallbackText;
            }
        }

        // Title generation runs in the background (see below); the promise is
        // handed back so the route can hold the SSE open briefly for the
        // `title` event without making `done` wait for a second model call.
        let pendingTitle = null;
        const conv = await agentStore.getDirectConversation(convId, userId, encryptionOpts(req));
        if (conv) {
            // When the frontend sends a truncated history (retry / edit), use that as
            // the persistence base instead of the full DB history.  This ensures the
            // retried messages are permanently deleted from the database.
            const dbMessages = conv.messages || [];
            let savedMessages;
            if (history && Array.isArray(history) && history.length < dbMessages.length) {
                // Retry / edit scenario — map the slim history back to the rich
                // saved rows. Alignment (not exact content equality) because DB
                // content is PII-tokenized ([email_1]) while the client sends
                // restored text: the old exact match silently degraded rows to
                // bare {role, content}, permanently wiping attachment sidecars
                // and timestamps out of the DB.
                const { alignClientToDb } = require('../../../core/conversation/historyMerge');
                savedMessages = alignClientToDb(history, dbMessages).map(({ client: h, dbMatch }) =>
                    dbMatch || {
                        role: h.role,
                        content: h.content,
                        timestamp: new Date().toISOString(),
                        ...(Array.isArray(h.attachments) && h.attachments.length > 0 ? { attachments: h.attachments } : {}),
                    });
                log.info(`[DirectChat] Retry detected — truncated DB messages from ${dbMessages.length} → ${savedMessages.length}`);
            } else {
                savedMessages = dbMessages;
            }
            const userSave = { role: 'user', content: moderationViolation ? '[Message removed - policy violation]' : tokenizedMessage, timestamp: new Date().toISOString() };
            if (persistedAttachments.length > 0) userSave.attachments = persistedAttachments;
            if (_userPrivacyMeta) Object.assign(userSave, _userPrivacyMeta);
            // Persist the tokenMap with the user row so the read-on-display
            // path can restore [email_N] → real values for the UI without
            // re-running PII detection. Cross-turn restoration also works
            // through dlpRunner.mergeTokenMap for chained references.
            if (piiTokenMap && Object.keys(piiTokenMap).length > 0) {
                userSave.tokenMap = piiTokenMap;
            }
            // Merge attachment scan summaries collected during attachment
            // processing into the assistant tokenisation info so the chat UI
            // can render a per-file badge ("3 emails, 1 IBAN redacted from invoice.pdf p.2").
            // Reads from `_turnAttachmentSummaries` (route-scoped) so it
            // survives the `messages = compactionResult.messages` reassignment.
            if (Array.isArray(_turnAttachmentSummaries) && _turnAttachmentSummaries.length > 0) {
                if (!_assistantTokenisationInfo) {
                    const aggCount = _turnAttachmentSummaries.reduce((a, s) => a + (s.count || 0), 0);
                    const aggCats = new Set();
                    for (const s of _turnAttachmentSummaries) {
                        for (const c of Object.keys(s.byCategory || {})) aggCats.add(c);
                    }
                    _assistantTokenisationInfo = {
                        source: 'privacy_shield',
                        action: 'redact',
                        count: aggCount,
                        categories: [...aggCats],
                        automatic: true,
                    };
                }
                _assistantTokenisationInfo.attachments = _turnAttachmentSummaries;
            }
            // Surface restored tokens too — on turns where no new redaction
            // fires but the AI's reply echoed tokens from earlier turns, the
            // un-tokeniser swapped them back to real values before the user
            // saw them. Synthesise the same shape the panel renders for fresh
            // redactions so the badge still appears.
            if (!_assistantTokenisationInfo && _streamUntok && typeof _streamUntok.getReplacedTokens === 'function') {
                const replaced = _streamUntok.getReplacedTokens();
                if (replaced && replaced.size > 0) {
                    const tokenMap = {};
                    const catSet = new Set();
                    let totalCount = 0;
                    for (const [token, info] of replaced) {
                        tokenMap[token] = info.value;
                        totalCount += info.count || 0;
                        const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(token);
                        if (m) catSet.add(m[1]);
                    }
                    _assistantTokenisationInfo = {
                        source: 'restored',
                        action: 'restore',
                        count: totalCount,
                        categories: [...catSet],
                        provider: modelId,
                        automatic: true,
                        tokenMap,
                    };
                    send('tokenisation_info', _assistantTokenisationInfo);
                } else {
                    // No token echo this turn — but if the conversation vault
                    // has any entries, surface the protected-state badge so
                    // the user gets continuous visual confirmation that
                    // privacy is engaged for this chat.
                    //
                    // IMPORTANT: state, not action. No PII detection runs on
                    // the AI's reply; the vault was populated on earlier
                    // turns.
                    const _dlpRunnerForSynth = require('../../../core/dlp/dlpRunner');
                    const convMap = _dlpRunnerForSynth.getConversationTokenMap(convId) || {};
                    const convEntries = Object.entries(convMap);
                    if (convEntries.length > 0) {
                        const catSet = new Set();
                        for (const [tok] of convEntries) {
                            const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok);
                            if (m) catSet.add(m[1]);
                        }
                        _assistantTokenisationInfo = {
                            source: 'conversation_vault',
                            action: 'protected',
                            count: convEntries.length,
                            categories: [...catSet],
                            provider: modelId,
                            automatic: true,
                            tokenMap: Object.fromEntries(convEntries),
                        };
                        send('tokenisation_info', _assistantTokenisationInfo);
                    }
                }
            }
            savedMessages.push(userSave);
            const assistantSave = { role: 'assistant', content: fullContent, timestamp: new Date().toISOString() };
            // Persist the concrete model + tier so the "How I got this answer"
            // panel still renders the right pill after a reload. `modelTier`
            // captures what the user picked ("auto" stays "auto" across reloads);
            // `autoSelectedTier` is the classifier's resolution when on auto,
            // and `modelId` is the actual model string the provider was called
            // with this turn.
            assistantSave.modelId = modelId;
            assistantSave.modelTier = resolvedTier;
            if (modelTier === 'auto') {
                assistantSave.autoSelectedTier = resolvedTier;
            }
            if (_assistantTokenisationInfo) assistantSave.tokenisationInfo = _assistantTokenisationInfo;
            // Prefer the structured thinking parts (with signatures + timing) over the flat string.
            // The flat string is kept as a fallback for providers that only emit `thinking` without
            // wrapping start/stop events.
            // Restore PII tokens in persisted thinking (display-only — thinking is
            // never replayed to the model, so this can't leak PII back to the LLM).
            // Without it the saved chain-of-thought keeps raw placeholder tokens like
            // [email_1] that resurface on reload (BFSF-253); mirrors the SSE restore.
            let _restoreTHd = (s) => s;
            try {
                const { restoreTokens } = require('../../../core/privacy/piiDetection');
                const _convMapTHd = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                if (_convMapTHd && Object.keys(_convMapTHd).length > 0) {
                    _restoreTHd = (s) => (typeof s === 'string' ? restoreTokens(s, _convMapTHd) : s);
                }
            } catch (_) { /* render-layer best-effort */ }
            if (thinkingParts.length > 0) {
                assistantSave.thinking = thinkingParts.map(p => ({
                    id: p.id,
                    text: _restoreTHd(p.text),
                    startedAt: p.startedAt,
                    endedAt: p.endedAt || Date.now(),
                    redacted: p.redacted || undefined,
                    signature: p.signature || undefined,
                    redactedData: p.redactedData || undefined,
                    phase: p.phase || undefined,
                }));
            } else if (thinkingContent) {
                assistantSave.thinking = _restoreTHd(thinkingContent);
            }
            if (generatedImages.length > 0) {
                // Strip base64 data from images for DB — keep only url/mimeType/storageKey
                assistantSave.images = generatedImages.map(img => {
                    if (img.url) {
                        return { url: img.url, mimeType: img.mimeType, storageKey: img.storageKey || null };
                    }
                    // No URL available — keep base64 as fallback
                    return { data: img.data, mimeType: img.mimeType };
                });
            }
            if (generatedAudio.length > 0) assistantSave.audioFiles = generatedAudio;
            if (generatedFiles.length > 0) assistantSave.files = generatedFiles;
            if (collectedEmailDrafts.length > 0) assistantSave.emailDrafts = collectedEmailDrafts;
            if (collectedCalendarDrafts.length > 0) assistantSave.calendarDrafts = collectedCalendarDrafts;
            if (collectedMapEmbeds.length > 0) assistantSave.mapEmbeds = collectedMapEmbeds;
            if (collectedToolHistory.length > 0) {
                // Render-time un-tokenisation for the saved tool history. The
                // `resultPreview` strings are captured straight from raw tool
                // output (which may contain `[person_N]` tokens) and surfaced
                // in the "How I got this answer" panel. The AI never reads
                // toolHistory back — it sees tool results inline during the
                // same turn — so swapping tokens for real values is purely a
                // user-render concern. Same applies to `query` / `find_text`
                // values inside the recorded args.
                try {
                    const { restoreTokens } = require('../../../core/privacy/piiDetection');
                    const _convMapForToolHist = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                    if (Object.keys(_convMapForToolHist).length > 0) {
                        for (const t of collectedToolHistory) {
                            if (typeof t?.resultPreview === 'string') {
                                t.resultPreview = restoreTokens(t.resultPreview, _convMapForToolHist);
                            }
                            if (t?.args && typeof t.args === 'object') {
                                for (const k of Object.keys(t.args)) {
                                    if (typeof t.args[k] === 'string') {
                                        t.args[k] = restoreTokens(t.args[k], _convMapForToolHist);
                                    }
                                }
                            }
                        }
                    }
                } catch (_) { /* render-layer best-effort */ }
                assistantSave.toolHistory = collectedToolHistory;
            }
            // Record the bootstrap so the UI can render a "Created N chat-local
            // skills" header above this assistant reply when reloaded.
            if (bootstrappedSessionSkills && Array.isArray(sessionSkills) && sessionSkills.length > 0) {
                assistantSave.sessionSkillsBootstrap = {
                    state: 'done',
                    skills: sessionSkills.map(s => ({
                        id: s.id,
                        name: s.name,
                        description: s.description || '',
                        icon: s.icon || '🧩',
                    })),
                };
            }
            // Per-turn pipeline snapshot — lets reloaded conversations replay
            // the timeline progression on each assistant message instead of
            // every old turn snapping to the final activation state. Includes
            // the completed set + per-step summaries so the UI can re-render
            // both the chip states and the green "✓ Step N — summary" rows.
            if (Array.isArray(sessionSkills) && sessionSkills.length > 0) {
                assistantSave.sessionSkillsSnapshot = {
                    activatedSkillIds: Array.isArray(activatedSessionSkillIds) ? [...activatedSessionSkillIds] : [],
                    completedSkillIds: Array.isArray(completedSessionSkillIds) ? [...completedSessionSkillIds] : [],
                    completions: Array.isArray(sessionSkillsCompletions) ? [...sessionSkillsCompletions] : [],
                };
            }
            savedMessages.push(assistantSave);

            // Save with metadata for OpenAI response chaining + compaction
            const updateMeta = {};
            if (lastResponseId) {
                updateMeta.lastResponseId = lastResponseId;
                updateMeta.lastResponseModel = modelId;
            }
            // Persist summary + watermark together. The explicit null/0 write
            // matters after invalidation (deep edit/retry): the meta merge
            // would otherwise keep a stale summary+watermark pair alive.
            if (conversationSummary || conversationSummary !== _loadedSummary) {
                updateMeta.conversationSummary = conversationSummary || null;
                updateMeta.summaryUpTo = conversationSummaryUpTo || 0;
            }
            if (isStandardTier && sessionSkills.length > 0) {
                updateMeta.sessionSkills = sessionSkills;
                updateMeta.activatedSessionSkillIds = activatedSessionSkillIds;
                updateMeta.completedSessionSkillIds = completedSessionSkillIds;
                updateMeta.sessionSkillsCompletions = sessionSkillsCompletions;
            }
            // Progressive tool disclosure — remember which heavy integration
            // groups this conversation expanded so later turns send them eager
            // (full schema) instead of re-discovering via load_tools.
            if (activatedToolGroups.size > 0) {
                updateMeta.activatedToolGroups = [...activatedToolGroups];
            }
            // Library-skill activations (skill-scoped app enablement) — later
            // turns re-include the activated skills' app tools from this. Key
            // is distinct from the session-skill activatedSessionSkillIds.
            if (activatedLibrarySkillIds.length > 0) {
                updateMeta.activatedSkillIds = [...activatedLibrarySkillIds];
            }
            await agentStore.updateDirectConversation(convId, savedMessages, userId, updateMeta, encryptionOpts(req));
            // Turn is durably recorded — a later throw (title generation etc.)
            // must not append a duplicate user/assistant pair via the hook.
            clearInterruptedTurnHook();

            // Only NOW tell the project — after the rows are committed. Firing
            // earlier would wake other members into reading a thread that does
            // not yet contain the turn they were told about.
            if (_sharedThread) {
                await emitThreadEvent(_sharedThread.projectId, {
                    kind: 'message.created',
                    actorId: userId,
                    targetType: 'conversation',
                    targetId: convId,
                });
            }
            // Persist the user's tier selection on the conversation so a refresh
            // restores the picker to what they last chose ("auto" stays "auto").
            // Without this, model_tier is frozen at creation and never reflects
            // mid-conversation switches.
            if (modelTier) {
                await agentStore.updateDirectConversationModelTier(convId, modelTier, userId).catch(() => {});
            }

            // Memory extraction runs ONCE per turn, at the tail of this
            // function — see "Memory extraction" below. A second pipeline
            // (the retired core/memoryExtractor) used to fire from here as
            // well: two fast-tier calls and two unawaited dedupe-then-insert
            // races on the same rows per message.

            // ─── Conversation title ──────────────────────────────────
            // Deferred to the SECOND assistant reply and built from the
            // conversation so far (tool-free), so the title reflects the real
            // topic rather than a vague opening line. The first reply just
            // seeds a "New Chat" placeholder so the sidebar isn't blank.
            // Idempotent: only (re)generates while the title is still a
            // placeholder, so a chat titled on turn 2 is never re-titled.
            const _assistantReplies = savedMessages.filter(m => m && m.role === 'assistant').length;
            const _titleIsPlaceholder = !conv.title || !String(conv.title).trim() || /^new chat$/i.test(String(conv.title).trim());
            log.info(`[DirectChat] Title check: assistantReplies=${_assistantReplies}, currentTitle="${conv.title || ''}", placeholder=${_titleIsPlaceholder}, moderationViolation=${!!moderationViolation}`);

            if (_assistantReplies >= 1 && _titleIsPlaceholder && !moderationViolation) {
                // Generate the real title as soon as there is one complete
                // exchange. This used to wait for the SECOND assistant reply, so
                // the very common single-turn chat stayed "New Chat" forever and
                // the sidebar never reflected the topic without a refresh (BFSF-209).
                // Second reply — generate the real title from the conversation,
                // using the SAME model selection + inference path as the chat
                // tier (getProviderForModel + getAdapter + adapter.chat). The
                // title model is the dedicated admin model if set, else the same
                // EU-aware Fast tier the chat resolves from, else this
                // conversation's model. When it equals the conversation model we
                // reuse the already-resolved adapter/key/url (no second lookup,
                // identical to the chat call).
                //
                // NOT awaited. This used to block the `done` event: on a
                // single-slot self-hosted server the title is another full
                // prompt evaluation, so the user watched a finished answer
                // sit "streaming" for seconds. The client reads the SSE until
                // the socket closes and applies `title` whenever it arrives
                // (useChatEngine), so the route holds the response open for
                // it — bounded — after sending `done`. Past that bound the
                // title still lands in the DB and shows on the next list load.
                pendingTitle = (async () => { try {
                    const llmClient = require('../../../core/llm/llmClient');
                    const titleAgent = await agentStore.getSystemAgent('system-title-generator');
                    const titleModelCfg = await configStore.getConfig('title_generation_model');
                    let titleModelId;
                    if (typeof titleModelCfg === 'string' && titleModelCfg.trim()) {
                        titleModelId = titleModelCfg.trim();
                    } else if (titleAgent?.model && !/^tier:/.test(titleAgent.model)) {
                        titleModelId = titleAgent.model;
                    } else {
                        titleModelId = tiers['fast']?.modelId || modelId;
                    }

                    // Resolve the provider exactly like the tier path; reuse the
                    // conversation's resolved provider when the model matches.
                    let tAdapter = adapter, tApiKey = apiKey, tApiUrl = apiUrl;
                    if (titleModelId && titleModelId !== modelId) {
                        const tCfg = await getProviderForModel(titleModelId);
                        tApiUrl = (tCfg.url || '').replace(/\/+$/, '');
                        tAdapter = getAdapter(tCfg.providerType, tApiUrl);
                        tApiKey = tCfg.apiKey;
                        titleModelId = tCfg.model || titleModelId;
                    }

                    // Tool-free transcript of the first two exchanges.
                    const transcript = buildTitleTranscript(savedMessages);
                    if (transcript && transcript.trim()) {
                        log.info(`[DirectChat] Title: generating with model=${titleModelId}`);
                        const title = await llmClient.generateTitleWithProvider(
                            { adapter: tAdapter, apiKey: tApiKey, apiUrl: tApiUrl, modelId: titleModelId },
                            transcript,
                            titleAgent?.system_prompt,
                            { maxInputChars: 1600 },
                        );
                        log.info(`[DirectChat] Title generated: "${title}" for conv ${convId}`);
                        await agentStore.updateDirectConversationTitle(convId, title, userId);
                        send('title', { title, conversationId: convId });
                    }
                } catch (e) {
                    log.error('[DirectChat] Title generation failed:', e.message, e.stack);
                    // Fallback so the sidebar isn't left blank if title-gen fails.
                    try { await agentStore.updateDirectConversationTitle(convId, 'New Chat', userId); send('title', { title: 'New Chat', conversationId: convId }); } catch (_) { /* non-fatal */ }
                } })();
            } else if (_assistantReplies >= 1 && _titleIsPlaceholder && moderationViolation) {
                // Moderation violation on a still-unnamed chat — safe generic title.
                const safeTitle = 'New Chat';
                try { await agentStore.updateDirectConversationTitle(convId, safeTitle, userId); } catch (_) { /* non-fatal */ }
                send('title', { title: safeTitle, conversationId: convId });
            }
        }

        // ─── Memory extraction (background, non-blocking) ──────────
        // ONE extractor (agents/memory/extractor.js), ONE call per turn.
        // Honors the per-session memoryWriteEnabled toggle (default true).
        // The project id is gated on the PROJECT's own extractMemories
        // setting — a project with extraction off must not accumulate
        // project-scoped memories (the ungated `validProjectId || null` form
        // did exactly that).
        //
        // The user message is un-tokenised first so memories remain
        // meaningful in a DIFFERENT conversation: the PII token map is
        // per-conversation, so a memory containing `[email_1]` recalled
        // elsewhere would be a dead placeholder. Privacy trade-off accepted:
        // real PII may appear in `user_memories` — local storage, not
        // external AI traffic. The saved history stays tokenised.
        if (!moderationViolation && req.body?.memoryWriteEnabled !== false) {
            try {
                const memoryExtractor = require('../../../agents/memory/extractor');
                let extractionMessages = messages;
                if (typeof tokenizedMessage === 'string' && tokenizedMessage) {
                    let userTextForMemory = tokenizedMessage;
                    try {
                        const { restoreTokens } = require('../../../core/privacy/piiDetection');
                        const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                        if (convMap && Object.keys(convMap).length > 0) {
                            userTextForMemory = restoreTokens(tokenizedMessage, convMap);
                        }
                    } catch (_) { /* fall back to the tokenised text */ }
                    extractionMessages = [{ role: 'user', content: userTextForMemory }];
                }
                memoryExtractor.extractFromConversation(userId, null, extractionMessages, convId, extractMemoriesEnabled ? validProjectId : null, userOrgForTiers || null)
                    .then(extracted => {
                        if (extracted.length > 0) {
                            log.info(`[DirectChat] Extracted ${extracted.length} memories`);
                        }
                    })
                    .catch(err => log.error('[DirectChat] Memory extraction failed:', err.message));
            } catch (e) { /* extractor load failed */ }
        } else {
            log.info(`[DirectChat] Skipping memory extraction — moderation violation detected`);
        }
        return { convId, pendingTitle };
}

module.exports = { finalizeDirectChatTurn };

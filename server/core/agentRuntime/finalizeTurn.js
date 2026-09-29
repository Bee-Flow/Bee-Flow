/**
 * Streaming agent chat — end-of-turn finalization.
 *
 * Runs once the model stops calling tools: strip stray tool-call XML /
 * think tags, build the assistant message with its persisted metadata
 * (drafts, tool history, thinking parts, KB sources, tokenisation info),
 * persist the turn, kick off memory extraction, schedule the server-side
 * redaction re-write and emit the raw-payload transparency event. Moved
 * verbatim out of chatStream.js; returns the turn's result object.
 */
const agentStore = require('../../stores/agentStore');
const log = require('../../telemetry/log');

async function finalizeStreamTurn({
    fullResponse, useNativeAdapter, onEvent, messageMetadata,
    _emailDrafts, _calendarDrafts, _linkedInDrafts, _mapEmbeds, _audioFiles, _generatedFiles = [],
    _pendingToolCalls = [],
    _toolHistory, _kbSources, _thinkingParts, _thinking, conversation,
    _ut, _captureRaw, _rawResponseBuffer,
    _assistantTokenisationInfo, _userPrivacyMeta, userSave, durableMessages,
    messages, persistDurable, isEphemeral, agent, agentId, userId,
    guardrailViolation, processedUserMessage, userMessage, userAuth,
    extractMemoriesEnabled, validProjectId, modelToUse, toolCalls,
    _serializeConversationWrite,
}) {
            // Strip raw tool-call XML tags from the response — some models (e.g. Mistral thinking)
            // output <tool_call>/<tool_response> as plain text instead of structured function calls.
            // BFSF-263: also strip COMPLETE <think> pairs that slipped through as
            // a defensive last line — but ONLY on the raw-fetch SSE path (OSS
            // models behind generic endpoints, where in-band reasoning is a
            // real failure mode). Native adapters already deliver reasoning as
            // typed thinking events, so a <think> pair in THEIR final text is
            // intentional content (e.g. the user asked for an example) and
            // must survive.
            if (fullResponse) {
                const originalLen = fullResponse.length;
                if (!useNativeAdapter) {
                    const { stripThinkTags } = require('../providers/thinkTagStream');
                    fullResponse = stripThinkTags(fullResponse);
                }
                fullResponse = fullResponse
                    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
                    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
                    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
                    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, '')
                    .trim();
                if (fullResponse.length !== originalLen) {
                    log.info(`[AgentRuntime] Stripped tool-call XML/think tags from response (${originalLen} → ${fullResponse.length} chars)`);
                    // Replace the content in the UI with the cleaned version
                    onEvent('content_replace', { text: fullResponse });
                }
            }

            // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed
            // when the Azure Content Safety backend was dropped. PII detection
            // runs via the GLiNER guard service, streamed through
            // `untokeniseStream` rather than gated here.

            // Include parentId for thread persistence
            const assistantMsg = {
                role: 'assistant',
                content: fullResponse,
                parentId: messageMetadata.parentId || null
            };

            // Attach persisted metadata
            if (_emailDrafts.length > 0) assistantMsg.emailDrafts = _emailDrafts;
            if (_calendarDrafts.length > 0) assistantMsg.calendarDrafts = _calendarDrafts;
            if (_linkedInDrafts.length > 0) assistantMsg.linkedInDrafts = _linkedInDrafts;
            if (_mapEmbeds.length > 0) assistantMsg.mapEmbeds = _mapEmbeds;
            if (_audioFiles.length > 0) assistantMsg.audioFiles = _audioFiles;
            if (_generatedFiles.length > 0) assistantMsg.files = _generatedFiles;
            // Tool calls held back for approval — same carrier as the drafts
            // above, so a reload shows the pending action and a client that
            // does not know the field simply ignores it.
            if (_pendingToolCalls.length > 0) assistantMsg.pendingToolCalls = _pendingToolCalls;
            if (_toolHistory.length > 0) {
                // Render-time un-tokenisation for the saved tool history —
                // mirror of the same pass in the direct-chat turn (routes/ai/directChat/).
                // toolHistory is never fed back to the AI; it surfaces in the
                // "How I got this answer" panel where the user wants real values.
                try {
                    const { restoreTokens } = require('../privacy/piiDetection');
                    const _convMapTH = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
                    if (Object.keys(_convMapTH).length > 0) {
                        for (const t of _toolHistory) {
                            if (typeof t?.resultPreview === 'string') {
                                t.resultPreview = restoreTokens(t.resultPreview, _convMapTH);
                            }
                            if (t?.args && typeof t.args === 'object') {
                                for (const k of Object.keys(t.args)) {
                                    if (typeof t.args[k] === 'string') {
                                        t.args[k] = restoreTokens(t.args[k], _convMapTH);
                                    }
                                }
                            }
                        }
                    }
                } catch (_) { /* render-layer best-effort */ }
                assistantMsg.toolHistory = _toolHistory;
            }
            if (_kbSources.length > 0) assistantMsg.kbSources = _kbSources;
            // Persistence format: `thinkingParts` is the structured array (with signatures
            // for Claude replay); `thinking` stays as the flat string for backwards compat
            // with memory extraction and anything reading the old shape.
            // Cap total thinking size — runaway models can emit hundreds of KB
            // of chain-of-thought, bloating conversation rows and slowing reads.
            const THINKING_BUDGET = 64 * 1024;
            const _capText = (s) => (typeof s === 'string' && s.length > THINKING_BUDGET)
                ? s.slice(0, THINKING_BUDGET) + '…[thinking truncated]'
                : (typeof s === 'string' ? s : '');
            // Restore PII tokens in persisted thinking too — same render-layer
            // rationale as the toolHistory pass above. Without this the saved
            // chain-of-thought keeps raw placeholder tokens (e.g. [email_1]) that
            // resurface verbatim on reload (BFSF-253). Best-effort; the live stream
            // is handled by the un-tokeniser wrapper.
            let _restoreTH = (s) => s;
            try {
                const { restoreTokens } = require('../privacy/piiDetection');
                const _convMapTHK = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
                if (_convMapTHK && Object.keys(_convMapTHK).length > 0) {
                    _restoreTH = (s) => (typeof s === 'string' ? restoreTokens(s, _convMapTHK) : s);
                }
            } catch (_) { /* render-layer best-effort */ }
            if (_thinkingParts.length > 0) {
                let budget = THINKING_BUDGET;
                assistantMsg.thinking = _thinkingParts.map(p => {
                    const text = _restoreTH(typeof p.text === 'string' ? p.text : '');
                    let outText;
                    if (budget <= 0) {
                        outText = '';
                    } else if (text.length <= budget) {
                        outText = text;
                        budget -= text.length;
                    } else {
                        outText = text.slice(0, budget) + '…[thinking truncated]';
                        budget = 0;
                    }
                    return {
                        id: p.id,
                        text: outText,
                        startedAt: p.startedAt,
                        endedAt: p.endedAt || Date.now(),
                        redacted: p.redacted || undefined,
                        signature: p.signature || undefined,
                        redactedData: p.redactedData || undefined,
                        phase: p.phase || undefined,
                    };
                });
            } else if (_thinking) {
                // Legacy path: flat-string thinking without part metadata.
                assistantMsg.thinking = _capText(_restoreTH(_thinking));
            }

            // Privacy / DLP — surface restored tokens too. On turns where no new
            // redaction fires (e.g. follow-up question with no PII), the AI's
            // response can still echo tokens from earlier turns that the
            // un-tokeniser swaps back to real values before the user sees them.
            // Synthesise a tokenisationInfo from those substitutions so the
            // "Privacy protection" panel still appears on the assistant message.
            if (!_assistantTokenisationInfo && _ut && typeof _ut.getReplacedTokens === 'function') {
                const _dlpRunnerForSynth = require('../dlp/dlpRunner');
                const replaced = _ut.getReplacedTokens();
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
                        provider: modelToUse,
                        automatic: true,
                        tokenMap,
                    };
                    // Push the full info to the client so the badge + panel
                    // render live, not only after refresh. The frontend merges
                    // this into the in-memory assistant message.
                    onEvent?.('tokenisation_info', _assistantTokenisationInfo);
                } else {
                    // No new redaction and no token echo in this reply, but if
                    // the conversation has any tokens in its vault, surface the
                    // protected-state badge so the user has continuous visual
                    // confirmation that privacy is engaged for this chat.
                    //
                    // IMPORTANT: this is state, not action. We do NOT run PII
                    // detection on the assistant's reply. The conv map below
                    // was populated on earlier turns; the AI naturally echoes
                    // tokens it was sent (or it doesn't, and the vault is
                    // simply quiet this turn).
                    const convMap = _dlpRunnerForSynth.getConversationTokenMap(conversation?.id) || {};
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
                            provider: modelToUse,
                            automatic: true,
                            tokenMap: Object.fromEntries(convEntries),
                        };
                        onEvent?.('tokenisation_info', _assistantTokenisationInfo);
                    }
                }
            }
            if (_assistantTokenisationInfo) {
                if (_captureRaw && _rawResponseBuffer) {
                    _assistantTokenisationInfo.rawResponse = _rawResponseBuffer;
                    _assistantTokenisationInfo.rawTruncated = _rawResponseBuffer.endsWith('…');
                }
                assistantMsg.tokenisationInfo = _assistantTokenisationInfo;
            }
            // Direct reference instead of a reverse scan: on a compacted turn the
            // scan could land on compaction's SYNTHETIC "[Original request …]"
            // user message rather than the real one.
            if (_userPrivacyMeta && userSave) {
                Object.assign(userSave, _userPrivacyMeta);
            }
            durableMessages.push(assistantMsg);
            messages.push(assistantMsg);
            await persistDurable();

            // ============ MEMORY EXTRACTION ============
            // Skip memory extraction if ephemeral, guardrail violation, or redaction occurred
            if (!isEphemeral && !agent.embed_enabled) {
                // Session-level memory write toggle from the chat composer.
                // Default-true so existing clients keep writing memories.
                const memoryWriteEnabled = messageMetadata?.memoryWriteEnabled !== false;
                const shouldSkipMemoryExtraction = !memoryWriteEnabled || guardrailViolation || processedUserMessage !== userMessage;

                const debugData = {
                    agentId,
                    conversationId: conversation.id,
                    guardrailViolation: !!guardrailViolation,
                    isRedacted: processedUserMessage !== userMessage,
                    memoryWriteEnabled,
                    shouldSkip: shouldSkipMemoryExtraction,
                    messagesCount: messages.length,
                    userMessageLength: userMessage.length
                };
                log.info(`[DEBUG] Memory Extraction Check:`, debugData);


                if (!shouldSkipMemoryExtraction) {
                    try {
                        const memoryExtractor = require('../../agents/memory/extractor');
                        memoryExtractor.extractFromConversation(userId, agentId, durableMessages, conversation.id, extractMemoriesEnabled ? validProjectId : null, messageMetadata?.userOrgId || null)
                            .then(extracted => {

                                if (extracted.length > 0) {
                                    log.info(`[AgentRuntime] Extracted ${extracted.length} memories from conversation`);
                                }
                            })
                            .catch(err => {
                                log.error('[AgentRuntime] Memory extraction failed:', err.message);
                                // Surface to the client so operators can see persistent extraction
                                // failures rather than silently losing all memory writes.
                                try { onEvent('memory_extraction_failed', { error: err.message }); } catch (_) { /* ignore */ }
                            });
                    } catch (memErr) {
                        log.error('[AgentRuntime] Memory extractor load failed:', memErr.message);

                    }
                } else {
                    log.info('[AgentRuntime] Skipping memory extraction due to guardrail violation or redaction');

                }
            }

            // ============ SERVER-SIDE PERSISTENCE FOR REDACTION ============
            // Schedule server-side persistence for both delete mode (guardrailViolation) and redact mode (processedUserMessage changed)
            // Skip for ephemeral embed chats
            if (!isEphemeral) {
                const needsServerPersistence = guardrailViolation || processedUserMessage !== userMessage;
                if (needsServerPersistence) {
                    const redactedContent = processedUserMessage !== userMessage
                        ? processedUserMessage  // Use redacted version (with [REDACTED: RuleName])
                        : '[Message removed - policy violation]';  // Full replacement for delete mode

                    // Persist redaction immediately after current event-loop tick
                    // (was setTimeout(5000) which raced with conversation save)
                    setImmediate(async () => {
                        try {
                            // restore:false — same reason as the guardrail-violation
                            // persistence path above: this block writes the array
                            // back via updateConversation, and restoring tokens here
                            // would silently overwrite tokenized content with real
                            // values for the whole conversation.
                            const conv = await agentStore.getConversationById(conversation.id, userAuth.encryptionKey, { restore: false });
                            if (conv && conv.messages) {
                                // Find the LAST user message (more robust than index-based lookup)
                                let lastUserIdx = -1;
                                for (let i = conv.messages.length - 1; i >= 0; i--) {
                                    if (conv.messages[i].role === 'user') {
                                        lastUserIdx = i;
                                        break;
                                    }
                                }
                                if (lastUserIdx < 0) {
                                    log.warn('[RegexGuard] No user message found for redaction');
                                    return;
                                }
                                const updatedMessages = conv.messages.map((m, idx) => {
                                    if (idx === lastUserIdx) {
                                        return { ...m, content: redactedContent, isRedacted: true };
                                    }
                                    return m;
                                });
                                await _serializeConversationWrite(conversation.id, () => agentStore.updateConversation(conversation.id, updatedMessages, userAuth.encryptionKey, userAuth.userId));
                                log.info(`[RegexGuard] Server-side persistence completed for conversation ${conversation.id}`);
                            }
                        } catch (redactErr) {
                            log.error('[RegexGuard] Server-side persistence failed:', redactErr.message);
                        }
                    });
                }
            }

            // Transparency: emit the accumulated raw (pre-un-tokenise) LLM
            // response once per turn, gated by the org's `showRawPayload` toggle.
            // This used to live in the post-loop block below, which is
            // unreachable (see the comment there), so the "How I got this
            // answer" panel never received it on the agent-chat path.
            if (_captureRaw && _rawResponseBuffer) {
                onEvent?.('privacy_response_raw', {
                    rawResponse: _rawResponseBuffer,
                    truncated: _rawResponseBuffer.endsWith('…'),
                    timestamp: Date.now(),
                });
            }

            return {
                message: fullResponse,
                toolCalls,
                conversationLength: durableMessages.length,
                conversationId: conversation.id,
                guardrailViolation: guardrailViolation || null,
                model: modelToUse
            };
}

module.exports = { finalizeStreamTurn };

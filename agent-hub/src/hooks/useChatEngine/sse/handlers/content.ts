import { appendPhase } from '../../phaseTrail';
import { completedTools, summarizeWorkItem } from '../../workSummary';
import { logger } from '../../../../utils/logger';
import type { SseHandlerMap } from '../handlerTypes';

/**
 * The reply's own stream: keepalive, text tokens, the pre-LLM phase line, the
 * model pick, and the end of the turn (done, error, history lock).
 */
export const contentHandlers: SseHandlerMap = {
    ping() {
        // SSE keepalive heartbeat (see server startSseHeartbeat). No-op —
        // its only job is to keep the connection warm through proxies so a
        // long, silent tool loop isn't idle-timed-out.
    },

    content(_ctx, data, ids) {
        const { contentRef, flusher } = ids;
        if (data.text) {
            // Append synchronously to the ref (always current), but defer
            // the React state commit to the next animation frame so a fast
            // token stream re-renders at ~60fps instead of per-token. The
            // flush settles the pre-LLM phase indicator and carries the
            // last-seen responder name/avatar — see createContentFlusher.
            contentRef.current += data.text;
            flusher.schedule(data.respondingAgentName, data.respondingAgentAvatar);
        }
    },

    phase(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        // Pre-LLM progress signal from any chat runtime. We render a
        // single rotating status line above the typing dots so users
        // see what is happening (KB search, attachment OCR, etc.)
        // instead of a silent stall before the first token.
        logger.debug('[phase]', data.stage, data.status, data.detail || '', '→ msgId', activeIdRef.current);
        setMessages(prev => {
            let updated = false;
            const next = prev.map(m => {
                if (m.id !== activeIdRef.current) return m;
                // The lasting TRAIL (A4 part C), next to the live line below. That line is
                // fleeting on purpose (every phase overwrites the previous one and the
                // answer's first letter clears it), so afterwards nothing showed what had
                // happened. This is the same stream, accumulated.
                //
                // The trail also gets the `end` the line below drops: phases overlap
                // (guardrails closes after privacy_scan), and by then `currentPhase` is
                // another one. For the live line that is right; for the trail it would
                // make a step's duration disappear.
                const phaseTrail = appendPhase(m.phaseTrail, data);
                if (data.status === 'end' && m.currentPhase?.stage !== data.stage) {
                    return phaseTrail === m.phaseTrail ? m : { ...m, phaseTrail };
                }
                const phase = (data.status === 'end' || data.stage === 'streaming_start')
                    ? null
                    : { stage: data.stage, detail: data.detail || null, startedAt: Date.now() };
                updated = true;
                return { ...m, currentPhase: phase, phaseTrail };
            });
            if (!updated) console.warn('[phase] no message matched activeIdRef', activeIdRef.current, 'msgIds=', prev.map(p => p.id));
            return next;
        });
    },

    content_replace(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId, contentRef, flusher } = ids;
        // Allow empty string to clear content (e.g. clearing intermediate tool-call planning text)
        if (data.text !== undefined) {
            // Drop any pending append flush — the replace is authoritative
            // and must not be clobbered by a late frame carrying old text.
            flusher.cancel();
            contentRef.current = data.text;
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: data.text } : m
            ));
        }
    },

    model_selected(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        // Server emits this on every turn now. `fromAuto` tells us
        // whether the user was on Auto (so we render "Auto → Fast")
        // versus a pinned tier (where we just show the model name).
        setMessages(prev => prev.map(m =>
            m.id === activeIdRef.current ? {
                ...m,
                modelId: data.modelId || m.modelId,
                modelTier: data.tier || m.modelTier,
                autoSelectedTier: data.fromAuto ? data.tier : m.autoSelectedTier,
            } : m
        ));
    },

    document_truncated(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        // The notebook document was too long for the system prompt — server
        // trimmed it to fit. Store the counts on the streaming message so
        // the UI can show a one-time banner ("Document too large — only
        // N of M tokens shown"). Client decides how to render; we just
        // attach the data.
        setMessages(prev => prev.map(m =>
            m.id === activeIdRef.current ? {
                ...m,
                documentTruncation: {
                    originalTokens: data.originalTokens,
                    keptTokens: data.keptTokens,
                },
            } : m
        ));
    },

    // The store refused to persist this turn over an encrypted history
    // it cannot open (locked). Page locks the composer in response.
    history_locked(ctx, data) {
        const { onHistoryLockedRef } = ctx;
        onHistoryLockedRef.current?.(data);
    },

    done(ctx, data, ids) {
        const { setMessages, onConversationCreated, onNotebookUpdate } = ctx;
        const { activeIdRef, flusher } = ids;
        // Commit any buffered tokens before finalizing — 'done' preserves
        // m.content, so a not-yet-flushed tail would otherwise be lost.
        flusher.flushNow();
        setMessages(prev => prev.map(m => {
            if (m.id === activeIdRef.current) {
                const update = { ...m, isStreaming: false, toolCall: null };
                if (m.thinkingSteps?.some(s => s.status === 'running')) {
                    update.thinkingSteps = m.thinkingSteps.map(s =>
                        s.status === 'running' ? { ...s, status: 'done' } : s
                    );
                }

                // Defense in depth: a well-formed 'done' can still carry an
                // empty reply (a provider failure swallowed upstream). A blank
                // bubble reads as "the conversation just stopped" — annotate it.
                // Replies that produced work cards without prose stay untouched.
                if ((!update.content || !update.content.trim()) && !m.workItem) {
                    update.content = '(The model returned an empty response — please try again.)';
                }

                return update;
            }
            return m;
        }));
        if (data.conversationId) {
            onConversationCreated?.(data.conversationId);
        }

        if (data.notebookspaceContent !== undefined) {
            onNotebookUpdate?.(data.notebookspaceContent);
        }
    },

    error(ctx, data, ids) {
        const { setMessages, tRef } = ctx;
        const { assistantMsgId, flusher, workRef } = ids;
        // Commit any buffered tokens now, so the reply so far is complete
        // when it is kept below; flushNow also cancels the scheduled frame,
        // so no late append can overwrite the error message.
        flusher.flushNow();
        const errMsg = typeof data.error === 'string'
            ? data.error
            : (data.error?.message || JSON.stringify(data.error) || 'An error occurred');
        // If work was already produced before the error, lead with what
        // was created so the error doesn't read as "nothing happened"
        // and trigger a duplicate retry (BFSF-221).
        const summary = summarizeWorkItem(tRef.current, workRef?.current);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const base = {
                ...m,
                isStreaming: false,
                isError: true,
                ...(summary ? { workItem: workRef.current } : {}),
            };
            // Tools that already finished in this turn (a ticket created,
            // a mail sent) HAPPENED, whatever failed after them. Keep the
            // reply so far, name those actions before the error, and flag
            // the message so it is not labelled "Failed to send": the
            // message was sent, and a retry would do the work twice
            // (BFSF-349). The tool rows stay on the message as they are.
            const done = completedTools(m);
            if (done.count === 0) {
                return { ...base, content: summary ? summary + '\n\n' + errMsg : errMsg };
            }
            const prior = (m.content && m.content.trim()) ? m.content.trimEnd() + '\n\n' : '';
            const toolsLine = tRef.current('chat.work_summary.tools', { tools: done.labels.join(', ') });
            const lead = summary ? `${summary}\n\n${toolsLine}` : toolsLine;
            return {
                ...base,
                content: `${prior}${lead}\n\n${errMsg}`,
                errorDetail: errMsg,
                completedToolCount: done.count,
            };
        }));
    },
};

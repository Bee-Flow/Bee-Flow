import type { SseHandlerMap } from '../handlerTypes';

/**
 * Privacy protection: the DLP review pause and its outcome, PII tokenisation
 * details for the privacy panel, and the block notice.
 */
export const privacyHandlers: SseHandlerMap = {
    dlp_preview(_ctx, data) {
        // Server is pausing the stream until the user responds via
        // the DLP decision endpoint. The modal listens for this event.
        window.dispatchEvent(new CustomEvent('beeflow:dlp_preview', { detail: data }));
    },

    dlp_attachment_preview(_ctx, data) {
        // Same pause, for a file attachment instead of the typed message —
        // one event per attachment that needs review (see
        // attachmentAskFlow.js: sequential, not batched). The modal
        // renders it in a document-shaped card instead of a chat bubble.
        window.dispatchEvent(new CustomEvent('beeflow:dlp_attachment_preview', { detail: data }));
    },

    dlp_resolved(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId, userMsgId } = ids;
        window.dispatchEvent(new CustomEvent('beeflow:dlp_resolved', { detail: data }));
        if (data?.appliedChoice === 'redact' && (data?.redactedCount ?? 0) > 0) {
            const info = {
                source: 'dlp',
                action: data.appliedChoice,
                count: data.redactedCount,
                categories: data.categories || [],
                provider: (typeof data.provider === 'object' ? data.provider?.displayName : undefined) || null,
                automatic: !!data.automatic,
            };
            setMessages(prev => prev.map(m => {
                if (m.id === userMsgId) {
                    return { ...m, dlpRedactedCount: data.redactedCount, dlpCategories: data.categories || [] };
                }
                // Also stash the info on the assistant message so the
                // "How I got this answer" panel can render the privacy step.
                if (m.id === assistantMsgId) {
                    return { ...m, tokenisationInfo: info };
                }
                return m;
            }));
        }
    },

    pii_tokenized(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId, userMsgId } = ids;
        const entities = Array.isArray(data?.entities) ? data.entities : [];
        const categories = [...new Set(entities.map(e => e.label || e.category).filter(Boolean))];
        const count = data?.tokenCount || entities.length;
        const attachments = Array.isArray(data?.attachments) ? data.attachments : null;
        // `pii_tokenized` now fires for both message-level PII and
        // attachment-level (Privacy Shield) detections. Merge with
        // any prior tokenisationInfo rather than replacing it — the
        // two paths can both fire on the same turn (user text + PDF).
        // Lightweight "scan incomplete" warnings (large upload passed
        // through unredacted under fail_open) — surfaced as an amber pill
        // under the USER message. Only rows that were NOT fully tokenised.
        const scanWarnings = (attachments || [])
            .filter(a => a && (a.reason || a.timeout || a.overflow) && a.action !== 'tokenize')
            .map(a => ({
                filename: a.filename,
                reason: a.reason || (a.timeout ? 'timeout' : (a.overflow ? 'overflow' : 'degraded')),
                scannedPages: a.scannedPages,
                totalPages: a.totalPages,
            }));
        setMessages(prev => prev.map(m => {
            if (m.id === userMsgId) {
                return {
                    ...m,
                    piiTokenizedCount: (m.piiTokenizedCount || 0) + count,
                    piiCategories: [...new Set([...(m.piiCategories || []), ...categories])],
                    piiScanWarnings: [...(m.piiScanWarnings || []), ...scanWarnings],
                };
            }
            if (m.id === assistantMsgId) {
                const prevInfo = m.tokenisationInfo || null;
                const mergedCats = [...new Set([...(prevInfo?.categories || []), ...categories])];
                const mergedCount = (prevInfo?.count || 0) + count;
                const info = {
                    source: data?.source || prevInfo?.source || 'pii',
                    action: prevInfo?.action || 'redact',
                    count: mergedCount,
                    categories: mergedCats,
                    provider: prevInfo?.provider || null,
                    automatic: prevInfo ? !!prevInfo.automatic : true,
                    // Attachments list (per-file detail) — only set when this
                    // event carries it. Existing per-file entries are
                    // preserved so a second event doesn't blow them away.
                    attachments: attachments
                        ? [...(prevInfo?.attachments || []), ...attachments]
                        : (prevInfo?.attachments || undefined),
                    tokenMap: prevInfo?.tokenMap || undefined,
                    tokenizedPrompt: prevInfo?.tokenizedPrompt || undefined,
                    rawResponse: prevInfo?.rawResponse || undefined,
                    rawTruncated: prevInfo?.rawTruncated,
                };
                return { ...m, tokenisationInfo: info };
            }
            return m;
        }));
    },

    privacy_payload(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Transparency: the exact tokenised string that was sent to the LLM.
        // Gated server-side by org `showRawPayload`. Attach to the assistant
        // message so "How I got this answer → Privacy protection" can render it.
        setMessages(prev => prev.map(m => m.id === assistantMsgId
            ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), tokenizedPrompt: data?.tokenizedPrompt || '', provider: data?.provider || m.tokenisationInfo?.provider || null } }
            : m));
    },

    privacy_response_raw(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // The raw pre-un-tokenise LLM response. Same gating as privacy_payload.
        setMessages(prev => prev.map(m => m.id === assistantMsgId
            ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), rawResponse: data?.rawResponse || '', rawTruncated: !!data?.truncated } }
            : m));
    },

    privacy_token_map(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Explicit { token: realValue } mapping. Server-gated by org `showRawPayload`.
        // Lets the privacy panel render an exact "[name_1] → Gerard" table.
        const incoming = data?.tokenMap || {};
        if (Object.keys(incoming).length === 0) return;
        setMessages(prev => prev.map(m => m.id === assistantMsgId
            ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), tokenMap: { ...(m.tokenisationInfo?.tokenMap || {}), ...incoming } } }
            : m));
    },

    tokenisation_info(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Server-synthesised tokenisation info for actions that don't
        // fire `dlp_resolved` (restore: AI echoed tokens this turn;
        // protected: conv vault non-empty even when no token activity
        // this turn). Carries count/action/categories/tokenMap so the
        // pill and Privacy panel render live, not only after refresh.
        if (!data || typeof data !== 'object') return;
        setMessages(prev => prev.map(m => m.id === assistantMsgId
            ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), ...data, tokenMap: { ...(m.tokenisationInfo?.tokenMap || {}), ...(data.tokenMap || {}) } } }
            : m));
    },

    dlp_blocked(ctx, data, ids) {
        const { setMessages, tRef } = ctx;
        const { assistantMsgId, flusher } = ids;
        window.dispatchEvent(new CustomEvent('beeflow:dlp_blocked', { detail: data }));
        // Drop any pending append so a buffered token can't overwrite
        // the block notice composed below.
        flusher.cancel();
        const reason = data?.reason || 'policy';
        let msg;
        // Every attachment branch carries the filename as a PARAMETER, not as a
        // piece of string in the code: the dictionary value wins over the
        // fallback (useTranslation.jsx), so a sentence built with `${file}` never
        // reached the screen and the user read a literal `{filename}`. Grammar
        // (with or without a filename) lives in the KEY, not in a suffix.
        const fileName = () => data?.filename || tRef.current('dlp.the_attachment', 'the attachment');
        if (reason === 'attachment_pii') {
            const cats = Array.isArray(data?.categories) && data.categories.length
                ? data.categories.join(', ')
                : tRef.current('dlp.categories_unknown', 'PII');
            const params = { categories: cats, filename: data?.filename };
            msg = data?.filename
                ? tRef.current('dlp.blocked_attachment_pii',
                    'Attachment blocked: sensitive data ({categories}) was detected in “{filename}”. Please remove the PII and re-upload.',
                    params)
                : tRef.current('dlp.blocked_attachment_pii_nofile',
                    'Attachment blocked: sensitive data ({categories}) was detected. Please remove the PII and re-upload.',
                    params);
        } else if (reason === 'attachment_overflow') {
            msg = tRef.current('dlp.blocked_attachment_overflow',
                'Attachment held: {filename} is too large to fully scan for sensitive data. Split it or reduce the page count, then re-upload.',
                { filename: fileName() });
        } else if (reason === 'attachment_timeout') {
            msg = tRef.current('dlp.blocked_attachment_timeout',
                "Attachment held: scanning {filename} for sensitive data didn't finish in time. Please try again or split the document.",
                { filename: fileName() });
        } else if (reason === 'attachment_degraded') {
            msg = tRef.current('dlp.blocked_attachment_degraded',
                'Attachment held: sensitive-data scanning for {filename} is temporarily unavailable. Please try again shortly.',
                { filename: fileName() });
        } else if (reason === 'attachment_user_blocked') {
            msg = tRef.current('dlp.blocked_attachment_user',
                '{filename} was not sent — you chose to block it during the review.',
                { filename: fileName() });
        } else if (reason === 'attachment_ask_timeout') {
            msg = tRef.current('dlp.blocked_attachment_ask_timeout',
                '{filename} was not sent — the privacy review timed out before you responded. Please try again.',
                { filename: fileName() });
        } else if (reason === 'pii_unavailable' && data?.kind === 'too_large') {
            // Same block, different truth. "Try again in a moment" is
            // actively misleading here: the retry scans the same text and
            // fails identically. Splitting the message is the only thing
            // that works, so say that instead.
            msg = tRef.current('dlp.blocked_pii_too_large',
                'This message is too large to scan for personal data, so it was not sent. Please split it into smaller parts.');
        } else if (reason === 'pii_unavailable') {
            // Fail-closed: PII detection was degraded (guard down / model
            // not ready), so the message was NOT sent unmasked (BFSF-269).
            msg = tRef.current('dlp.blocked_pii_unavailable',
                'Privacy protection is temporarily unavailable, so your message was not sent. Please try again in a moment.');
        } else {
            const labelKey = reason === 'timeout' ? 'dlp.blocked_timeout'
                : reason === 'user_blocked' ? 'dlp.blocked_user'
                : 'dlp.blocked_policy';
            msg = tRef.current(labelKey, {
                timeout: 'Blocked: DLP decision timed out.',
                user_blocked: 'Prompt blocked by you.',
                policy: 'Prompt blocked by data-loss-prevention policy.',
            }[reason] || 'Prompt blocked by DLP.');
        }
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, content: msg, isStreaming: false, isError: true } : m
        ));
    },
};

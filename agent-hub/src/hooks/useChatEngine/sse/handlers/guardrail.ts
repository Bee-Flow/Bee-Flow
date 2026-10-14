import type { SseHandlerMap } from '../handlerTypes';

/**
 * Guardrails: redacting or removing the user's message after a violation,
 * and the canned reply when a turn is blocked.
 */
export const guardrailHandlers: SseHandlerMap = {
    content_redact(ctx, data, ids) {
        const { setMessages } = ctx;
        const { userMsgId } = ids;
        const seconds = data.autoRedactSeconds || 5;
        setMessages(prev => prev.map(m =>
            m.id === userMsgId ? { ...m, isGuardrailViolation: true, deleteIn: seconds, willRedact: true } : m
        ));
        setTimeout(() => {
            setMessages(prev => prev.map(m =>
                m.id === userMsgId ? { ...m, content: data.redactedMessage, isGuardrailViolation: false, isRedacted: true, willRedact: false } : m
            ));
        }, seconds * 1000);
    },

    guardrail_violation(ctx, data, ids) {
        const { setMessages } = ctx;
        const { userMsgId } = ids;
        const secs = data.autoDeleteSeconds || 5;
        const categories = data.categories || data.rules || [];
        const categoryText = Array.isArray(categories) ? categories.join(', ') : '';
        setMessages(prev => prev.map(m =>
            m.id === userMsgId ? { ...m, isGuardrailViolation: true, deleteIn: secs, violationCategories: categoryText } : m
        ));
        setTimeout(() => {
            setMessages(prev => prev.map(m =>
                m.id === userMsgId ? { ...m, content: '[Message removed - policy violation]', isGuardrailViolation: false, isDeleted: true } : m
            ));
        }, secs * 1000);
    },

    guardrail_blocked(ctx, data, ids) {
        const { setMessages, tRef } = ctx;
        const { activeIdRef, contentRef, flusher } = ids;
        // Drop any pending append — the canned response is authoritative.
        flusher.cancel();
        // Compose translated canned response using i18n keys
        const title = tRef.current('chat.guardrail_blocked_title', { violation: data.violation || 'Policy Violation' });
        const body = tRef.current('chat.guardrail_blocked_body');
        const translatedResponse = `${title}\n\n${body}`;
        contentRef.current = translatedResponse;
        setMessages(prev => prev.map(m =>
            m.id === activeIdRef.current ? { ...m, content: translatedResponse } : m
        ));
    },
};

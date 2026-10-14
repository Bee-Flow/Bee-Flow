import type { SseHandlerMap } from '../handlerTypes';

/**
 * Extended-thinking blocks streamed onto the in-flight message.
 */
export const thinkingHandlers: SseHandlerMap = {
    thinking_start(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        const partId = data.partId;
        if (partId) {
            setMessages(prev => prev.map(m => {
                if (m.id !== activeIdRef.current) return m;
                const parts = Array.isArray(m.thinkingParts) ? [...m.thinkingParts] : [];
                if (parts.find(p => p.id === partId)) return m;
                parts.push({
                    id: partId,
                    text: '',
                    startedAt: Date.now(),
                    endedAt: null,
                    redacted: data.redacted || false,
                });
                return { ...m, thinkingParts: parts, thinkingStartedAt: m.thinkingStartedAt || Date.now() };
            }));
        }
    },

    thinking(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        if (data.text) {
            setMessages(prev => prev.map(m => {
                if (m.id !== activeIdRef.current) return m;
                const prevParts = Array.isArray(m.thinkingParts) ? m.thinkingParts : [];
                const parts = prevParts.map(p => ({ ...p })); // deep-clone each part so we can safely mutate
                let idx = data.partId ? parts.findIndex(p => p.id === data.partId) : -1;
                if (idx === -1) {
                    const lastIdx = parts.length - 1;
                    if (!data.partId && lastIdx >= 0 && !parts[lastIdx].endedAt) {
                        idx = lastIdx;
                    } else {
                        parts.push({
                            id: data.partId || `auto-${parts.length}`,
                            text: '',
                            startedAt: Date.now(),
                            endedAt: null,
                        });
                        idx = parts.length - 1;
                    }
                }
                parts[idx] = { ...parts[idx], text: parts[idx].text + data.text };
                return {
                    ...m,
                    thinkingParts: parts,
                    thinking: (m.thinking || '') + data.text,
                    thinkingStartedAt: m.thinkingStartedAt || Date.now(),
                };
            }));
        }
    },

    thinking_stop(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        if (data.partId) {
            setMessages(prev => prev.map(m => {
                if (m.id !== activeIdRef.current) return m;
                const prevParts = Array.isArray(m.thinkingParts) ? m.thinkingParts : [];
                const parts = prevParts.map(p =>
                    p.id === data.partId
                        ? { ...p, endedAt: Date.now(), redacted: p.redacted || !!data.redacted }
                        : p
                );
                return { ...m, thinkingParts: parts, thinkingEndedAt: Date.now() };
            }));
        }
    },
};

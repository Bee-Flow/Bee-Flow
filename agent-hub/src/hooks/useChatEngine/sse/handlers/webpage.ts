import type { SseHandlerMap } from '../handlerTypes';

/**
 * The webpage builder: file and source callbacks, DOM broadcasts for the DB
 * viewer and project settings, and the plan approval card.
 */
export const webpageHandlers: SseHandlerMap = {
    // Webpage-specific events (file: 'html'|'css'|'js', content: string)
    webpage_doc_update(ctx, data) {
        const { onWebpageDocUpdateRef } = ctx;
        onWebpageDocUpdateRef.current?.({ file: data.file, content: data.content, title: data.title });
    },

    webpage_source_added(ctx, data) {
        const { onWebpageSourceAddedRef } = ctx;
        onWebpageSourceAddedRef.current?.(data.source);
    },

    // Multi-file events: extra-file create/update or delete.
    webpage_extra_update(ctx, data) {
        const { onWebpageExtraUpdateRef } = ctx;
        onWebpageExtraUpdateRef.current?.({ path: data.path, meta: data.meta });
    },

    webpage_extra_deleted(ctx, data) {
        const { onWebpageExtraDeletedRef } = ctx;
        onWebpageExtraDeletedRef.current?.({ path: data.path });
    },

    // DB tool wrote — re-broadcast as a DOM event so the open DB
    // viewer (if mounted) can refresh its schema/rows. Avoids drilling
    // a callback through the chat → IDE → viewer prop chain.
    webpage_db_update() {
        try { window.dispatchEvent(new CustomEvent('webpage_db_update')); } catch (_) {}
    },

    // The AI switched this project's framework / runtime tier. Re-broadcast
    // as a DOM event so the page can update settings + recompose the
    // preview without drilling a callback through the prop chain.
    webpage_framework_changed(_ctx, data) {
        try { window.dispatchEvent(new CustomEvent('webpage_framework_changed', { detail: { framework: data.framework } })); } catch (_) {}
    },

    webpage_runtime_changed(_ctx, data) {
        try { window.dispatchEvent(new CustomEvent('webpage_runtime_changed', { detail: { runtime: data.runtime } })); } catch (_) {}
    },

    // Webpage plan proposal — attach to the in-flight assistant message
    // so the chat can render an approval card. The user will click
    // Approve/Reject and the plan card flips status; on Approve a new
    // chat send is fired with planExecution: { planId, action: 'execute' }.
    webpage_plan_proposed(ctx, data) {
        const { setMessages } = ctx;
        if (data && data.planId && data.plan) {
            const planEntry = { planId: data.planId, plan: data.plan, status: 'pending' };
            setMessages(prev => {
                if (!prev || prev.length === 0) return prev;
                for (let i = prev.length - 1; i >= 0; i--) {
                    if (prev[i].role === 'assistant') {
                        return [
                            ...prev.slice(0, i),
                            { ...prev[i], webpagePlan: planEntry },
                            ...prev.slice(i + 1),
                        ];
                    }
                }
                return prev;
            });
        }
    },
};

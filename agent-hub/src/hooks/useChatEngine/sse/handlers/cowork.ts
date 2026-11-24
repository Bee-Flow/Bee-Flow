import type { SseHandlerMap } from '../handlerTypes';

/**
 * "It notices what you repeat" (server/core/cowork/habits/habitSignals.mts): after a turn, the server may say that this
 * kind of turn came four weeks in a row on this weekday. The server never knew the words, so the brief of the cowork
 * to offer is the message on screen: it is read here from the turn's own user message and handed, with the weekday,
 * to the chip that offers it (components/cowork/CoworkHabitChip.tsx), as a window event like the DLP preview's.
 */
export const coworkHandlers: SseHandlerMap = {
    cowork_suggestion(ctx, data, ids) {
        const weekday = typeof (data as { weekday?: unknown })?.weekday === 'number' ? (data as { weekday: number }).weekday : null;
        if (weekday === null) return;
        let told = false;
        ctx.setMessages((prev) => {
            const asked = prev.find((m) => m.id === ids.userMsgId);
            const brief = typeof asked?.content === 'string' ? asked.content.trim() : '';
            if (!told && brief) {
                told = true;
                queueMicrotask(() => window.dispatchEvent(new CustomEvent('beeflow:cowork_suggestion', { detail: { weekday, brief } })));
            }
            return prev;
        });
    },
};

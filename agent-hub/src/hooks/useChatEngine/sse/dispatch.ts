import { answerPartHandlers } from './handlers/answerParts';
import { contentHandlers } from './handlers/content';
import { draftHandlers } from './handlers/drafts';
import { guardrailHandlers } from './handlers/guardrail';
import { notebookHandlers } from './handlers/notebook';
import { privacyHandlers } from './handlers/privacy';
import { sessionHandlers } from './handlers/session';
import { swarmHandlers } from './handlers/swarm';
import { thinkingHandlers } from './handlers/thinking';
import { toolHandlers } from './handlers/tools';
import { webpageHandlers } from './handlers/webpage';
import type { SseHandler, SseHandlerMap } from './handlerTypes';
import type { SseDispatchContext, SseDispatchIds, SseEventData } from '../types';
import { logger } from '../../../utils/logger';

/**
 * Merges the family maps into one lookup. A Map (not a plain object), so an
 * event named after an Object.prototype key (`toString`) finds nothing, just
 * as it matched no `case` before. An event claimed by two families throws at
 * load: the old switch would silently have run the first one.
 */
export function buildHandlerTable(families: SseHandlerMap[]): Map<string, SseHandler> {
    const table = new Map<string, SseHandler>();
    for (const family of families) {
        for (const [event, handler] of Object.entries(family)) {
            if (table.has(event)) throw new Error(`SSE event "${event}" has two handlers`);
            table.set(event, handler);
        }
    }
    return table;
}

export const SSE_HANDLERS = buildHandlerTable([
    contentHandlers,
    thinkingHandlers,
    guardrailHandlers,
    swarmHandlers,
    sessionHandlers,
    toolHandlers,
    draftHandlers,
    answerPartHandlers,
    notebookHandlers,
    webpageHandlers,
    privacyHandlers,
]);

/**
 * Dispatches one parsed SSE event from the chat stream onto React state and
 * the page-level callbacks. Extracted verbatim from useChatEngine's
 * `handleSSEEvent` useCallback — the hook wraps this in a useCallback and
 * threads its own state setters/refs via `ctx`, so behaviour (including which
 * values are captured at memoization time) is unchanged.
 *
 * An event without a handler is ignored, as the switch it replaces had no
 * `default` branch.
 */
export function dispatchSSEEvent(
    ctx: SseDispatchContext,
    event: string,
    data: SseEventData,
    ids: SseDispatchIds,
): void {
    // DEBUG: log non-content events to help debug LinkedIn draft issue
    if (event !== 'content' && event !== 'thinking' && event !== 'ping') {
        logger.debug('[SSE Event]', event, data);
    }

    SSE_HANDLERS.get(event)?.(ctx, data, ids);
}

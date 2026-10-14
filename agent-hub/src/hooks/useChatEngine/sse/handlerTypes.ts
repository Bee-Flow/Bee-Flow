import type { SseDispatchContext, SseDispatchIds, SseEventData } from '../types';

/** One SSE event's effect on the engine's state and the page callbacks. */
export type SseHandler = (ctx: SseDispatchContext, data: SseEventData, ids: SseDispatchIds) => void;

/** The handlers of one event family, keyed by event name. */
export type SseHandlerMap = Record<string, SseHandler>;

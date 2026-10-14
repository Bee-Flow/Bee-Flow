/**
 * The chat stream's SSE dispatcher. The handlers live per event family in
 * `./sse/handlers/`, merged and looked up in `./sse/dispatch.ts`; this path
 * stays the import for useChatEngine and the tests.
 */
export { dispatchSSEEvent } from './sse/dispatch';

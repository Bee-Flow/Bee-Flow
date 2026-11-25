/**
 * The planner's model call (./coworkPlanner.mts): one request to the owner's model, tried again when the provider
 * was briefly unavailable (the builder's own notion of "briefly", usecases/ai/builderShared.js). A request that was
 * stopped is never tried again.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Message = Record<string, unknown>;
export interface ChatAnswer { content?: string | null; toolCalls?: Array<{ id: string; function: { name: string; arguments?: unknown }; [key: string]: unknown }> | null; usage?: unknown }
type Chat = (modelId: string, messages: Message[], options: Record<string, unknown>) => Promise<ChatAnswer>;

export interface ChatDeps {
    chat: Chat;
    isTransient: (err: unknown) => boolean;
    wait: (ms: number) => Promise<void>;
}

const defaults = (): ChatDeps => ({
    chat: (modelId, messages, options) => (nodeRequire('../core/llm/llmClient.js') as { chat: Chat }).chat(modelId, messages, options),
    isTransient: (err) => (nodeRequire('./ai/builderShared.js') as { isTransientChatError: (e: unknown) => boolean }).isTransientChatError(err),
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
});

export const PLANNER_CHAT_TRIES = 3;
const FIRST_WAIT_MS = 500;

export async function plannerChat(modelId: string, messages: Message[], options: Record<string, unknown>, over: Partial<ChatDeps> = {}): Promise<ChatAnswer> {
    const deps = { ...defaults(), ...over };
    const signal = options.signal instanceof AbortSignal ? options.signal : null;
    for (let tried = 1; ; tried++) {
        try {
            return await deps.chat(modelId, messages, options);
        } catch (err) {
            if (tried >= PLANNER_CHAT_TRIES || signal?.aborted || !deps.isTransient(err)) throw err;
            await deps.wait(FIRST_WAIT_MS * 2 ** (tried - 1));
        }
    }
}

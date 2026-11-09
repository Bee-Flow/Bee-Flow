import type { ChatMessage } from '@/hooks/useChatEngine/types';

/** One finished question and answer of the test chat, as "This conversation as a test" records it. */
export interface TestChatTurn {
    question: string;
    answer: string;
    /** Names of the tools that finished in this turn, once each. */
    toolsUsed: string[];
}

/**
 * The last turn of the test chat that can be turned into a test, or null.
 *
 * A turn counts only when its answer is finished: still streaming, failed or empty
 * answers are not something to record. The question is the user message right before
 * the answer, and hidden messages never count.
 */
export function lastCompletedTurn(messages: ChatMessage[]): TestChatTurn | null {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || last.isStreaming || last.isError) return null;
    const answer = typeof last.content === 'string' ? last.content.trim() : '';
    if (!answer) return null;
    const asked = messages[messages.length - 2];
    const question = asked && asked.role === 'user' && typeof asked.content === 'string' ? asked.content.trim() : '';
    if (!question) return null;
    const names = (last.toolHistory || [])
        .filter(call => call.status === 'done' && typeof call.name === 'string' && call.name)
        .map(call => call.name as string);
    return { question, answer, toolsUsed: [...new Set(names)] };
}

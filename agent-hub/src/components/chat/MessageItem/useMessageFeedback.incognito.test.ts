import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useMessageFeedback, type FeedbackContext } from './useMessageActions';

/**
 * Feedback from an incognito chat: the rating and the comment still go, the
 * conversation never does, and the box that would offer it is not shown.
 */

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
});
afterEach(() => { fetchSpy.mockRestore(); });

const context = (incognito: boolean): FeedbackContext => ({
    msg: { id: 'm2', role: 'assistant', content: 'Answer' },
    idx: 1,
    chatSource: 'direct',
    allMessages: [{ id: 'm1', role: 'user', content: 'Secret question' }, { id: 'm2', role: 'assistant', content: 'Answer' }],
    incognito,
});

async function submitWithConversation(incognito: boolean) {
    const { result } = renderHook(() => useMessageFeedback(context(incognito)));
    act(() => { result.current.handleThumbClick('down'); });
    act(() => { result.current.setIncludeConversation(true); });
    act(() => { result.current.handleFeedbackSubmit(); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    return { result, submitted: JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body)) };
}

describe('useMessageFeedback in incognito', () => {
    it('sends the rating without the conversation snapshot, and does not offer it', async () => {
        const { result, submitted } = await submitWithConversation(true);
        expect(result.current.canIncludeConversation).toBe(false);
        expect(submitted).toMatchObject({ rating: 'down', messageId: 'm2' });
        expect(submitted).not.toHaveProperty('conversationSnapshot');
    });

    it('a normal chat still sends the snapshot when asked to', async () => {
        const { result, submitted } = await submitWithConversation(false);
        expect(result.current.canIncludeConversation).toBe(true);
        expect(submitted.conversationSnapshot).toHaveLength(2);
    });
});

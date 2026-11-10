import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import scopedStorage from '../utils/scopedStorage';
import useChatEngine, { type UseChatEngineOptions } from './useChatEngine';

function streamResponse(events: string[]) {
    const chunks = events.map((c) => new TextEncoder().encode(c));
    let i = 0;
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
            getReader: () => ({
                read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
                cancel: () => Promise.resolve(),
            }),
        },
    } as unknown as Response;
}

const SKILLS = 'event: session_skills_updated\ndata: {"skills":[{"id":"s1","name":"Research"}],"activatedSkillIds":["s1"]}\n\n';
const DONE = 'event: done\ndata: {"conversationId":"c1"}\n\n';

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
    localStorage.clear();
    scopedStorage.setCurrentUser('u1');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse([SKILLS, DONE]));
});
afterEach(() => {
    fetchSpy.mockRestore();
    scopedStorage.setCurrentUser(null);
});

describe('useChatEngine — onSessionSkillsChanged', () => {
    it('calls the callback of the current render, not the one it was first given', async () => {
        // The page hands a new callback when the open conversation changes. The
        // SSE handler listed two of its three callbacks as dependencies, so a
        // change of this one alone left the old closure in place.
        const first = vi.fn();
        const second = vi.fn();
        const selectedAgent = { id: 'a1' };
        const { result, rerender } = renderHook(
            (options: UseChatEngineOptions) => useChatEngine(options),
            { initialProps: { selectedAgent, onSessionSkillsChanged: first } },
        );
        rerender({ selectedAgent, onSessionSkillsChanged: second });

        await act(async () => { await result.current.sendMessage('Hello'); });
        await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
        expect(second).toHaveBeenCalledWith({ skills: [{ id: 's1', name: 'Research' }], activatedSkillIds: ['s1'] });
        expect(first).not.toHaveBeenCalled();
    });
});

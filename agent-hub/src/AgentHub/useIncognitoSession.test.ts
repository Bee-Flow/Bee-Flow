import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import useIncognitoSession, { useIncognitoControls } from './useIncognitoSession';
import type { ChatMessage } from '@/hooks/useChatEngine/types';

/**
 * The incognito session as the hub wires it: on from the toggle, ended by
 * whatever replaces the conversation on screen (a new chat, another
 * conversation or agent) or by the chat view going away, and never sticky.
 */

const TURN: ChatMessage[] = [{ id: 'u', role: 'user', content: 'private' }, { id: 'a', role: 'assistant', content: 'ok' }];

const setCoworkMode = vi.fn();
const setSelectedTier = vi.fn();
const stopGenerating = vi.fn();

function useHub(selectedTier = 'fast') {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const { incognitoSession, setIncognito: setIncognitoSession, endIncognito } = useIncognitoSession();
    const controls = useIncognitoControls({ endIncognito, setIncognitoSession, setMessages, stopGenerating, setCoworkMode, selectedTier, setSelectedTier });
    return { messages, setMessages, incognitoSession, ...controls };
}

function startIncognitoChat(tier?: string) {
    const hook = renderHook(() => useHub(tier));
    act(() => { hook.result.current.setIncognito(true); });
    // The engine appends the turn with its own (raw) setter.
    act(() => { hook.result.current.setMessages(TURN); });
    return hook;
}

describe('useIncognitoSession with the hub controls', () => {
    it('turning it on puts the composer on plain chat and a tier incognito offers', () => {
        const { result } = renderHook(() => useHub('swarm'));
        act(() => { result.current.setIncognito(true); });
        expect(result.current.incognitoSession?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(setCoworkMode).toHaveBeenCalledWith('chat');
        expect(setSelectedTier).toHaveBeenCalledWith('auto');
    });

    it('a new chat ends it, and the next chat starts in normal mode', () => {
        const { result } = startIncognitoChat();
        act(() => { result.current.replaceMessages([]); });
        expect(result.current.incognitoSession).toBeNull();
        expect(result.current.messages).toEqual([]);
    });

    it('opening another conversation ends it and shows that conversation', () => {
        const { result } = startIncognitoChat();
        const other: ChatMessage[] = [{ id: 'x', role: 'user', content: 'saved chat' }];
        act(() => { result.current.replaceMessages(other); });
        expect(result.current.incognitoSession).toBeNull();
        expect(result.current.messages).toEqual(other);
    });

    it('the chat view going away clears the incognito messages, and a normal chat is left alone', () => {
        const { result } = startIncognitoChat();
        act(() => { result.current.leaveIncognito(); });
        expect(result.current.incognitoSession).toBeNull();
        expect(result.current.messages).toEqual([]);

        act(() => { result.current.setMessages(TURN); });
        act(() => { result.current.leaveIncognito(); });
        expect(result.current.messages).toEqual(TURN);
    });

    it('a navigation that already ended the session is not undone by the unmount after it', () => {
        const { result } = startIncognitoChat();
        const other: ChatMessage[] = [{ id: 'x', role: 'user', content: 'saved chat' }];
        act(() => {
            result.current.replaceMessages(other);
            result.current.leaveIncognito();
        });
        expect(result.current.messages).toEqual(other);
    });

    it('mints a new session id every time it is turned on', () => {
        const { result } = renderHook(() => useHub());
        act(() => { result.current.setIncognito(true); });
        const first = result.current.incognitoSession?.sessionId;
        act(() => { result.current.setIncognito(false); });
        expect(result.current.incognitoSession).toBeNull();
        act(() => { result.current.setIncognito(true); });
        expect(result.current.incognitoSession?.sessionId).not.toBe(first);
    });
});

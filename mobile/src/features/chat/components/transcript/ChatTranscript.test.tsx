/**
 * The streaming performance contract: while an answer streams, only its own
 * cell re-renders. Every finished bubble is a markdown tree, and re-rendering
 * all of them 20 times a second is what made long chats stutter. And when the
 * answer finishes, its bubble is updated in place, not rebuilt.
 *
 * And the way back to the newest message: a turn that starts is brought into
 * view, and a transcript scrolled away from it offers a jump back.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { FlatList } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { ChatMessage } from '@/features/chat/model/types';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ChatTranscript } from './ChatTranscript';

const mockRenders = new Map<string, number>();
const mockMounts = new Map<string, number>();
jest.mock('@/features/chat/components/message/MessageBubble', () => {
    const { memo, useEffect } = jest.requireActual<typeof import('react')>('react');
    const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
    return {
        MessageBubble: memo(function MessageBubble({
            message,
        }: {
            message: { id: string; content: string; tools?: { name: string }[] };
        }) {
            mockRenders.set(message.id, (mockRenders.get(message.id) ?? 0) + 1);
            useEffect(() => {
                mockMounts.set(message.id, (mockMounts.get(message.id) ?? 0) + 1);
            }, [message.id]);
            const tools = message.tools?.map((tool) => tool.name).join(',') ?? '';
            return (
                <RNText testID={`bubble-${message.id}`} accessibilityHint={tools}>
                    {message.content}
                </RNText>
            );
        }),
    };
});

const MESSAGES: ChatMessage[] = [
    { id: 'live', role: 'assistant', content: '', streaming: true },
    { id: 'done', role: 'assistant', content: 'An earlier answer' },
    { id: 'q', role: 'user', content: 'A question' },
];

beforeEach(() => {
    mockRenders.clear();
    mockMounts.clear();
});

it('re-renders the streaming cell per flush and leaves the finished ones alone', async () => {
    const store = createStore(() => ({ text: '' }));
    const actions = { feedback: { conversationId: 'c1', source: 'direct' as const } };
    await renderWithProviders(<ChatTranscript messages={MESSAGES} store={store} actions={actions} />);
    const settled = { done: mockRenders.get('done'), q: mockRenders.get('q') };

    for (const text of ['He', 'Hell', 'Hello']) {
        await act(async () => {
            store.setState({ text });
        });
    }

    expect(screen.getByTestId('bubble-live').props.children).toBe('Hello');
    expect(mockRenders.get('live')).toBeGreaterThanOrEqual(4);
    expect({ done: mockRenders.get('done'), q: mockRenders.get('q') }).toEqual(settled);
});

it('settles the streamed answer into the same bubble instead of remounting it', async () => {
    const store = createStore(() => ({ text: 'Hello' }));
    const transcript = createStore(() => ({ messages: MESSAGES }));
    function Harness() {
        const messages = useStore(transcript, (state) => state.messages);
        return <ChatTranscript messages={messages} store={store} />;
    }
    await renderWithProviders(<Harness />);
    expect(screen.getByTestId('bubble-live').props.children).toBe('Hello');

    await act(async () => {
        transcript.setState({
            messages: [{ id: 'live', role: 'assistant', content: 'Hello' }, ...MESSAGES.slice(1)],
        });
    });

    expect(screen.getByTestId('bubble-live').props.children).toBe('Hello');
    expect(mockMounts.get('live')).toBe(1);
});

it("draws the whole live turn into the streaming cell, not just its words", async () => {
    const store = createStore(() => ({
        text: 'Looking',
        tools: [{ id: 't1', name: 'web_search', status: 'running' as const }],
    }));
    await renderWithProviders(<ChatTranscript messages={MESSAGES} store={store} />);
    expect(screen.getByTestId('bubble-live').props.accessibilityHint).toBe('web_search');
    expect(screen.getByTestId('bubble-done').props.accessibilityHint).toBe('');
});

describe('the newest message', () => {
    const SETTLED: ChatMessage[] = MESSAGES.slice(1);
    const scrollTo = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    const scrolled = async (y: number) => {
        await fireEvent.scroll(screen.getByTestId('bubble-done'), { nativeEvent: { contentOffset: { x: 0, y } } });
    };

    beforeEach(() => scrollTo.mockClear());

    it('is offered once the transcript is scrolled away from it, and gone again back there', async () => {
        await renderWithProviders(<ChatTranscript messages={SETTLED} store={createStore(() => ({ text: '' }))} />);
        expect(screen.queryByLabelText('Jump to the latest message')).toBeNull();

        await scrolled(900);
        await fireEvent.press(screen.getByLabelText('Jump to the latest message'));
        expect(scrollTo).toHaveBeenCalledWith({ offset: 0, animated: true });

        await scrolled(0);
        expect(screen.queryByLabelText('Jump to the latest message')).toBeNull();
    });

    it('is where a turn that starts is brought, even from far up', async () => {
        const store = createStore(() => ({ text: '' }));
        const transcript = createStore(() => ({ messages: SETTLED }));
        function Harness() {
            const messages = useStore(transcript, (state) => state.messages);
            return <ChatTranscript messages={messages} store={store} />;
        }
        await renderWithProviders(<Harness />);
        await scrolled(900);
        expect(scrollTo).not.toHaveBeenCalled();

        await act(async () => {
            transcript.setState({
                messages: [{ id: 'p2', role: 'assistant', content: '', streaming: true }, { id: 'q2', role: 'user', content: 'Next' }, ...SETTLED],
            });
        });
        expect(scrollTo).toHaveBeenCalledWith({ offset: 0, animated: false });

        // The answer streaming in, and settling, is not a new turn: reading
        // further up meanwhile is left alone.
        scrollTo.mockClear();
        await act(async () => {
            transcript.setState({ messages: [{ id: 'p2', role: 'assistant', content: 'Done' }, ...transcript.getState().messages.slice(1)] });
        });
        expect(scrollTo).not.toHaveBeenCalled();
    });
});

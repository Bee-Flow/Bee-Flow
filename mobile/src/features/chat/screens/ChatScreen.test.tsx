/**
 * A turn on the conversation screen, end to end against a mocked server:
 * what Stop leaves on screen once the server has been asked again, what a new
 * chat shows while its first fetch is out, and what leaving mid-answer asks.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Pressable, Text } from 'react-native';

import { api } from '@/core/api/client';
import type { SseFrame } from '@/core/api/sse';
import { renderScreen } from '@/shared/testing/renderWithProviders';
import { pressBack, type HeldLeave } from '@/shared/testing/screenMocks';

import { ChatScreen } from './ChatScreen';
import { useDeleteConversation } from '../hooks/mutations';

jest.setTimeout(30_000);

const mockPush = jest.fn();
const mockHeld: HeldLeave = { listener: null, dispatch: jest.fn() };
const mockStreamSse = jest.fn();

jest.mock('expo-router', () => {
    const mocks = jest.requireActual('@/shared/testing/screenMocks');
    return { ...mocks.expoRouter(() => mockPush), useNavigation: mocks.leaveNavigation(() => mockHeld) };
});
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/sse', () => ({ streamSse: (...args: unknown[]) => mockStreamSse(...args) }));
jest.mock('@/features/skills', () => ({ useActiveSkills: () => ({ activeSkillIds: [] }) }));
jest.mock('@/features/knowledge', () => ({ useKnowledgeBases: () => ({ data: [], isLoading: false }) }));
jest.mock('@/features/search', () => ({ consumePendingShare: () => null, describeSharedPayload: jest.fn() }));
jest.mock('@/features/integrations', () => ({
    INTEGRATION_CATALOG: [],
    allowedByOrg: (catalogue: unknown[]) => catalogue,
    useUserSettings: () => ({ data: { enabledApps: null, orgEnabledIntegrations: null } }),
    useSaveEnabledApps: () => ({ mutate: jest.fn() }),
}));

const frame = (event: string, data: unknown = {}): SseFrame => ({ event, data });

const EARLIER = [
    { id: 's1', role: 'user', content: 'Earlier question' },
    { id: 's2', role: 'assistant', content: 'Earlier answer' },
];

const conversation = (id: string, messages: unknown[]) => ({
    id,
    title: 'Reports',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    messages,
    knowledgeBaseIds: [],
});

/** The server: conversation reads answered by `read`, everything else (tiers, flags) empty. */
function serve(read: (id: string) => Promise<unknown>) {
    jest.mocked(api.get).mockImplementation(async (path: string) => {
        const match = /^\/ai\/direct\/conversations\/([^/]+)$/.exec(path);
        return match ? read(decodeURIComponent(match[1] ?? '')) : null;
    });
}

const conversationReads = () => jest.mocked(api.get).mock.calls.filter(([path]) => String(path).startsWith('/ai/direct/conversations/')).length;

/** A stream that sends `frames` and then stays open until the turn is stopped. */
function streamHanging(frames: SseFrame[]) {
    mockStreamSse.mockImplementation(async function* (_path: string, opts: { signal: AbortSignal }) {
        for (const f of frames) yield f;
        await new Promise<never>((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
}

async function ask(words: string) {
    await fireEvent.changeText(screen.getByLabelText('Chat message'), words);
    await fireEvent.press(screen.getByLabelText('Send message'));
}

beforeEach(() => {
    jest.mocked(api.get).mockReset();
    mockStreamSse.mockReset();
    mockHeld.listener = null;
    mockHeld.dispatch.mockClear();
});

it('keeps a stopped question and the words that arrived after the server is asked again', async () => {
    serve(async (id) => conversation(id, EARLIER));
    streamHanging([frame('content', { text: 'The first half' })]);
    await renderScreen(<ChatScreen id="c1" />);
    expect(await screen.findByText('Earlier answer')).toBeTruthy();

    await ask('Summarise the report');
    expect(await screen.findByText('The first half')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Stop generating'));

    // The refetch after the turn lands, and the server saved nothing.
    await waitFor(() => expect(conversationReads()).toBe(2));
    expect(await screen.findByText('Answer stopped early')).toBeTruthy();
    expect(screen.getByText('Summarise the report')).toBeTruthy();
    expect(screen.getByText('The first half')).toBeTruthy();
});

it('lets a refused question go with the refetch, rather than keep it as a stopped answer to retry', async () => {
    serve(async (id) => conversation(id, EARLIER));
    // A guardrail in block mode: the server refuses, says `done`, and saves nothing.
    mockStreamSse.mockImplementation(async function* () {
        yield frame('guardrail_violation', { reason: 'Personal data' });
        yield frame('done', {});
    });
    await renderScreen(<ChatScreen id="c1" />);
    await screen.findByText('Earlier answer');

    await ask('My BSN is 123456782');
    await waitFor(() => expect(conversationReads()).toBe(2));
    await waitFor(() => expect(screen.queryByText('My BSN is 123456782')).toBeNull());
    expect(screen.queryByText('Answer stopped early')).toBeNull();
    // The notice says why, from the live turn.
    expect(screen.getByText(/A guardrail stopped this response\./)).toBeTruthy();
});

it('keeps a new chat’s first answer on screen while the chat is fetched', async () => {
    let answered = false;
    serve(() => new Promise(() => {}));
    mockStreamSse.mockImplementation(async function* () {
        yield frame('content', { text: 'Hi there' });
        answered = true;
        yield frame('done', { conversationId: 'c9' });
    });
    await renderScreen(<ChatScreen id="new" draft="Hello" />);

    await waitFor(() => expect(conversationReads()).toBe(1));
    expect(answered).toBe(true);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
});

it('asks before leaving while an answer is being written, and lets go on "Stop and leave"', async () => {
    serve(async (id) => conversation(id, EARLIER));
    streamHanging([frame('content', { text: 'Working' })]);
    await renderScreen(<ChatScreen id="c1" />);
    await screen.findByText('Earlier answer');
    expect(mockHeld.listener).toBeNull();

    await ask('A long question');
    await screen.findByText('Working');
    const event = await pressBack(mockHeld);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText('Stop this answer?')).toBeTruthy();
    await fireEvent.press(screen.getByText('Stop and leave'));
    expect(mockHeld.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
});

/** The details screen's Delete: its leave pops the chat under it (router.dismiss(2)) in the same callback. */
const dismissals: { preventDefault: jest.Mock; data: { action: unknown } }[] = [];
function DeleteFromDetails() {
    const destroy = useDeleteConversation('c7', {
        onDeleted: () => {
            // The chat screen hears beforeRemove at once, before anything renders again.
            const dismissal = { preventDefault: jest.fn(), data: { action: { type: 'POP', payload: { count: 2 } } } };
            dismissals.push(dismissal);
            mockHeld.listener?.(dismissal);
        },
    });
    return (
        <Pressable accessibilityRole="button" onPress={() => destroy.mutate()}>
            <Text>Delete from details</Text>
        </Pressable>
    );
}

it('leaves without asking when the conversation is deleted from its details mid-answer', async () => {
    serve(async (id) => conversation(id, EARLIER));
    streamHanging([frame('content', { text: 'Working' })]);
    jest.mocked(api.delete).mockResolvedValue(undefined);
    dismissals.length = 0;
    await renderScreen(
        <>
            <ChatScreen id="c7" />
            <DeleteFromDetails />
        </>,
    );
    await screen.findByText('Earlier answer');
    await ask('A long question');
    await screen.findByText('Working');
    expect(mockHeld.listener).not.toBeNull();

    await fireEvent.press(screen.getByText('Delete from details'));
    await waitFor(() => expect(dismissals).toHaveLength(1));
    expect(dismissals[0]?.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText('Stop this answer?')).toBeNull();
});

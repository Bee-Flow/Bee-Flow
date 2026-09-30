/**
 * The hand-back: local turns leave once the server has them, and not before.
 * A turn that just ended is still local until a fetch newer than the turn
 * lands, so it never vanishes for a round trip in between.
 */

import { act, renderHook } from '@testing-library/react-native';

import { useLocalTranscript, type LocalTranscriptOptions, type TurnStart } from './useLocalTranscript';
import { unsavedFailure } from '../model/retry';
import type { FinishedTurn } from '../model/transcript';
import type { ChatMessage } from '../model/types';

const DROP_ALL = (): ChatMessage[] => [];
const EARLIER: ChatMessage[] = [
    { id: 's1', role: 'user', content: 'Earlier question' },
    { id: 's2', role: 'assistant', content: 'Earlier answer' },
];
const FINISHED: FinishedTurn = { text: 'Hi there', thinking: '', tools: [], sources: [], images: [], error: null };

type Props = Omit<LocalTranscriptOptions, 'keep'>;

async function mount(initial: Props) {
    return renderHook((props: Props) => useLocalTranscript({ ...props, keep: DROP_ALL }), {
        initialProps: initial,
    });
}

const contents = (messages: ChatMessage[]) => messages.map((m) => m.content).reverse();

it('keeps a finished turn on screen until a fetch newer than the turn lands', async () => {
    const hook = await mount({ persisted: EARLIER, persistedAt: 1, streaming: false });

    await act(async () => {
        hook.result.current.begin('Hello', []);
    });
    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: true });
    await act(async () => {
        hook.result.current.settle(FINISHED, false);
    });
    // The turn ended; the only transcript on hand is the one from before it.
    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: false });
    expect(contents(hook.result.current.messages)).toEqual(['Earlier question', 'Earlier answer', 'Hello', 'Hi there']);

    // The refetch has the turn: the local copy goes, and nothing is doubled.
    const saved: ChatMessage[] = [
        ...EARLIER,
        { id: 's3', role: 'user', content: 'Hello' },
        { id: 's4', role: 'assistant', content: 'Hi there' },
    ];
    await hook.rerender({ persisted: saved, persistedAt: 2, streaming: false });
    expect(contents(hook.result.current.messages)).toEqual(['Earlier question', 'Earlier answer', 'Hello', 'Hi there']);
    expect(hook.result.current.messages.map((m) => m.id).reverse()).toEqual(['s1', 's2', 's3', 's4']);
});

it('hands back on a fetch when no turn has run', async () => {
    const hook = await mount({ persisted: [], persistedAt: 0, streaming: false });
    await act(async () => {
        hook.result.current.fail(hook.result.current.begin('Hello', []).placeholderId, 'Too big');
    });
    expect(hook.result.current.messages).toHaveLength(2);

    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: false });
    expect(hook.result.current.messages.map((m) => m.id).reverse()).toEqual(['s1', 's2']);
});

it("keeps a stopped turn through the refetch that follows it, until the server's copy has it", async () => {
    const hook = await renderHook((props: Props) => useLocalTranscript({ ...props, keep: unsavedFailure }), {
        initialProps: { persisted: EARLIER, persistedAt: 1, streaming: false },
    });
    await act(async () => {
        hook.result.current.begin('Summarise it', []);
    });
    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: true });
    await act(async () => {
        hook.result.current.settle({ ...FINISHED, text: 'The first half' }, true);
    });
    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: false });

    // The refetch after Stop: the server saved nothing. The turn stays, marked.
    await hook.rerender({ persisted: EARLIER, persistedAt: 2, streaming: false });
    expect(contents(hook.result.current.messages)).toEqual(['Earlier question', 'Earlier answer', 'Summarise it', 'The first half']);
    expect(hook.result.current.messages[0]).toMatchObject({ interrupted: true });

    // A later fetch has the turn (the provider finished it): the saved copy wins, once.
    const saved: ChatMessage[] = [
        ...EARLIER,
        { id: 's3', role: 'user', content: 'Summarise it' },
        { id: 's4', role: 'assistant', content: 'The first half, and the rest.' },
    ];
    await hook.rerender({ persisted: saved, persistedAt: 3, streaming: false });
    expect(hook.result.current.messages.map((m) => m.id).reverse()).toEqual(['s1', 's2', 's3', 's4']);
});

it('lets a stopped edit of a saved question go, so the saved transcript comes back in its order', async () => {
    const SAVED: ChatMessage[] = [
        ...EARLIER,
        { id: 's3', role: 'user', content: 'Later question' },
        { id: 's4', role: 'assistant', content: 'Later answer' },
    ];
    const hook = await renderHook((props: Props) => useLocalTranscript({ ...props, keep: unsavedFailure }), {
        initialProps: { persisted: SAVED, persistedAt: 1, streaming: false },
    });
    let turn!: TurnStart;
    await act(async () => {
        turn = hook.result.current.begin('Earlier question, reworded', [], { cutFrom: 's1' });
    });
    expect(turn.historyOverride).toBe(true);
    expect(contents(hook.result.current.messages)).toEqual(['Earlier question, reworded', '']);
    await hook.rerender({ persisted: SAVED, persistedAt: 1, streaming: true });
    await act(async () => {
        hook.result.current.settle({ ...FINISHED, text: 'Half a new' }, true);
    });
    await hook.rerender({ persisted: SAVED, persistedAt: 1, streaming: false });

    // The server never finished the turn, so it never truncated its copy: the
    // edit goes, rather than sitting after the answers it was meant to replace.
    await hook.rerender({ persisted: SAVED, persistedAt: 2, streaming: false });
    expect(hook.result.current.messages.map((m) => m.id).reverse()).toEqual(['s1', 's2', 's3', 's4']);
});

it('holds the hand-back while a turn is still being prepared, its files encoding', async () => {
    const SAVED: ChatMessage[] = [
        ...EARLIER,
        { id: 's3', role: 'user', content: 'Later question' },
        { id: 's4', role: 'assistant', content: 'Later answer' },
    ];
    const hook = await renderHook((props: Props) => useLocalTranscript({ ...props, keep: unsavedFailure }), {
        initialProps: { persisted: SAVED, persistedAt: 1, streaming: false },
    });
    // An edit with a photo: the transcript is cut, and the stream has not opened yet.
    await act(async () => {
        hook.result.current.begin('Later question, with the photo', [{ name: 'photo.jpg', uri: 'file:///photo.jpg' }], { cutFrom: 's3' });
    });
    // A refetch lands meanwhile (the title catch-up): nothing moves.
    await hook.rerender({ persisted: SAVED, persistedAt: 2, streaming: false });
    expect(contents(hook.result.current.messages)).toEqual(['Earlier question', 'Earlier answer', 'Later question, with the photo', '']);
    expect(hook.result.current.messages[0]).toMatchObject({ streaming: true });

    // The turn runs and ends; the refetch after it hands back as always.
    await hook.rerender({ persisted: SAVED, persistedAt: 2, streaming: true });
    await act(async () => {
        hook.result.current.settle(FINISHED, false);
    });
    await hook.rerender({ persisted: SAVED, persistedAt: 2, streaming: false });
    const saved: ChatMessage[] = [
        ...EARLIER,
        { id: 's5', role: 'user', content: 'Later question, with the photo' },
        { id: 's6', role: 'assistant', content: 'Hi there' },
    ];
    await hook.rerender({ persisted: saved, persistedAt: 3, streaming: false });
    expect(hook.result.current.messages.map((m) => m.id).reverse()).toEqual(['s1', 's2', 's5', 's6']);
});

it('still keeps a stopped question that replaced only unsaved ones', async () => {
    const hook = await renderHook((props: Props) => useLocalTranscript({ ...props, keep: unsavedFailure }), {
        initialProps: { persisted: EARLIER, persistedAt: 1, streaming: false },
    });
    let failed = '';
    await act(async () => {
        failed = hook.result.current.begin('Summarise it', []).placeholderId;
    });
    await act(async () => hook.result.current.fail(failed, 'Too big'));
    // A retry of the failed, never-saved turn cuts only local messages.
    await act(async () => {
        hook.result.current.begin('Summarise it', [], { cutFrom: hook.result.current.messages[1]?.id });
    });
    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: true });
    await act(async () => {
        hook.result.current.settle({ ...FINISHED, text: 'The first half' }, true);
    });
    await hook.rerender({ persisted: EARLIER, persistedAt: 1, streaming: false });
    await hook.rerender({ persisted: EARLIER, persistedAt: 2, streaming: false });
    expect(contents(hook.result.current.messages)).toEqual(['Earlier question', 'Earlier answer', 'Summarise it', 'The first half']);
});

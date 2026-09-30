/**
 * The local half of a transcript: how a sent turn appears before the server
 * confirms it, and how the finished answer is written into its placeholder.
 */

import {
    assistantPlaceholder,
    cutAt,
    failPlaceholder,
    historyOf,
    lastSavedOf,
    mergeTranscript,
    settleStreaming,
    userMessage,
    type FinishedTurn,
} from './transcript';
import type { ChatMessage } from './types';

const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role,
    content,
    ...extra,
});

const FINISHED: FinishedTurn = {
    text: 'Answer',
    thinking: '',
    tools: [],
    sources: [],
    images: [],
    error: null,
};

describe('mergeTranscript', () => {
    it('adds local messages the server does not have yet, newest first', () => {
        const persisted = [msg('a', 'user', 'q1'), msg('b', 'assistant', 'a1')];
        const local = [msg('b', 'assistant', 'a1'), msg('c', 'user', 'q2')];
        expect(mergeTranscript(persisted, local).map((m) => m.id)).toEqual(['c', 'b', 'a']);
    });

    it('leaves out what an edit cut away and replies inside a thread', () => {
        const persisted = [msg('a', 'user', 'q1'), msg('r', 'user', 'reply', { parentId: 'a' }), msg('b', 'assistant', 'a1')];
        expect(mergeTranscript(persisted, [], new Set(['b'])).map((m) => m.id)).toEqual(['a']);
    });
});

describe('cutAt', () => {
    const visible = [msg('a', 'user', 'q1'), msg('b', 'assistant', 'a1'), msg('c', 'user', 'q2'), msg('d', 'assistant', 'a2')];

    it('keeps what came before and tells the server when a saved message goes', () => {
        const cut = cutAt(visible, new Set(['a', 'b', 'c', 'd']), 'c');
        expect(cut.before.map((m) => m.id)).toEqual(['a', 'b']);
        expect(cut.removed.map((m) => m.id)).toEqual(['c', 'd']);
        expect(cut.override).toBe(true);
    });

    it('needs no override when only unsaved messages go, and cuts nothing for an unknown id', () => {
        expect(cutAt(visible, new Set(['a', 'b']), 'c').override).toBe(false);
        expect(cutAt(visible, new Set(), 'zz')).toEqual({ before: visible, removed: [], override: false });
    });
});

describe('lastSavedOf', () => {
    it('names the last saved message a new question follows, past any unsaved ones', () => {
        const before = [msg('a', 'user', 'q1'), msg('b', 'assistant', 'a1'), msg('l1', 'user', 'stopped'), msg('l2', 'assistant', 'half')];
        expect(lastSavedOf(before, new Set(['a', 'b']))).toBe('b');
        expect(lastSavedOf(before.slice(2), new Set(['a', 'b']))).toBeNull();
    });
});

describe('historyOf', () => {
    it('sends only user and assistant turns with text', () => {
        const local = [
            msg('1', 'user', 'q'),
            msg('2', 'assistant', '  '),
            msg('3', 'tool', 'x'),
            msg('4', 'assistant', 'a'),
            msg('5', 'user', 'retry me'),
        ];
        expect(historyOf(local)).toEqual([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
            { role: 'user', content: 'retry me' },
        ]);
    });
});

describe('a turn', () => {
    it('starts as the question and a streaming placeholder', () => {
        expect(userMessage('u', 'hi', [])).toMatchObject({ id: 'u', role: 'user', content: 'hi', attachments: [] });
        expect(assistantPlaceholder('p')).toEqual({ id: 'p', role: 'assistant', content: '', streaming: true });
    });

    it('writes the finished answer into the placeholder only', () => {
        const settled = settleStreaming(
            [msg('u', 'user', 'q'), assistantPlaceholder('p')],
            { ...FINISHED, thinking: 'why' },
            false,
        );
        expect(settled[0]).toEqual(msg('u', 'user', 'q'));
        // Empty parts are left off, so a plain answer stays a plain message.
        expect(settled[1]).toMatchObject({ id: 'p', role: 'assistant', content: 'Answer', streaming: false, thinking: 'why' });
        expect(settled[1]?.tools).toBeUndefined();
        expect(settled[1]?.error).toBeUndefined();
    });

    it("puts what the shield did to the question on the question", () => {
        const userPrivacy = { tokenizedCount: 2, dlpRedactedCount: 0, categories: ['Email'], scanWarnings: [] };
        const settled = settleStreaming([msg('u', 'user', 'q'), assistantPlaceholder('p')], { ...FINISHED, userPrivacy }, false);
        expect(settled[0]?.privacy).toEqual(userPrivacy);
        expect(settled[1]?.privacy).toBeUndefined();
    });

    it('marks an interrupted turn and keeps an error as the message error', () => {
        const [cut] = settleStreaming([assistantPlaceholder('p')], { ...FINISHED, text: '' }, true);
        expect(cut).toMatchObject({ content: '', interrupted: true, thinking: undefined });
        const [failed] = settleStreaming([assistantPlaceholder('p')], { ...FINISHED, error: 'Down' }, false);
        expect(failed).toMatchObject({ error: 'Down', interrupted: undefined });
    });

    it('keeps the words of a turn that was stopped, and marks it', () => {
        const [stopped] = settleStreaming([assistantPlaceholder('p')], { ...FINISHED, text: 'The first half' }, true);
        expect(stopped).toMatchObject({ content: 'The first half', interrupted: true, streaming: false, error: undefined });
    });

    it('fails the placeholder of a turn whose attachment could not be encoded', () => {
        const [failed] = failPlaceholder([assistantPlaceholder('p')], 'p', 'Too large');
        expect(failed).toEqual({ id: 'p', role: 'assistant', content: '', streaming: false, error: 'Too large' });
    });
});

// The in-memory chat search: what matches (and what never does), and walking
// the matches up and down without ever landing out of range.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';
import useChatSearch from './useChatSearch';

let seq = 0;
const msg = (content: string, over: Partial<TeamChatMessage> = {}): TeamChatMessage => {
    seq += 1;
    return {
        id: `m${seq}`, seq, authorKind: 'user', authorUserId: 'u-ada', agentId: null, content,
        mentions: [], replyTo: null, createdAt: '2026-10-01T10:00:00Z', editedAt: null, deleted: false, ...over,
    };
};

describe('useChatSearch', () => {
    it('matches nothing until there is a query, and matches case-insensitively', () => {
        const { result } = renderHook(() => useChatSearch([msg('Deploy on Friday'), msg('Lunch?')]));
        expect(result.current.matches).toHaveLength(0);
        expect(result.current.activeId).toBeNull();

        act(() => result.current.setQuery('FRIDAY'));
        expect(result.current.matches.map(m => m.content)).toEqual(['Deploy on Friday']);
        expect(result.current.activeId).toBe(result.current.matches[0].id);
    });

    it('never matches deleted, undecryptable or thread messages', () => {
        const messages = [
            msg('budget talk', { deleted: true }),
            msg('budget again', { unreadable: true, content: '' }),
            msg('budget in a thread', { threadId: 'root' }),
            msg('budget in the open'),
        ];
        const { result } = renderHook(() => useChatSearch(messages));
        act(() => result.current.setQuery('budget'));
        expect(result.current.matches.map(m => m.content)).toEqual(['budget in the open']);
    });

    it('walks next/prev with wraparound, and a new query restarts at the first match', () => {
        const messages = [msg('one ai'), msg('two ai'), msg('three ai')];
        const { result } = renderHook(() => useChatSearch(messages));
        act(() => result.current.setQuery('ai'));
        expect(result.current.active).toBe(0);

        act(() => result.current.next());
        act(() => result.current.next());
        expect(result.current.active).toBe(2);
        expect(result.current.activeId).toBe(messages[2].id);
        act(() => result.current.next());
        expect(result.current.active).toBe(0);
        act(() => result.current.prev());
        expect(result.current.active).toBe(2);

        act(() => result.current.setQuery('two'));
        expect(result.current.active).toBe(0);
        expect(result.current.activeId).toBe(messages[1].id);
    });

    it('keeps the active index in range when the matches shrink under it', () => {
        const messages = [msg('cat one'), msg('cat two')];
        const { result, rerender } = renderHook(({ list }) => useChatSearch(list), { initialProps: { list: messages } });
        act(() => result.current.setQuery('cat'));
        act(() => result.current.next());
        expect(result.current.active).toBe(1);

        rerender({ list: [messages[0]] });
        expect(result.current.active).toBe(0);
        expect(result.current.activeId).toBe(messages[0].id);
    });

    it('next/prev on an empty result set are harmless', () => {
        const { result } = renderHook(() => useChatSearch([msg('nothing here')]));
        act(() => result.current.setQuery('zzz'));
        act(() => { result.current.next(); result.current.prev(); });
        expect(result.current.active).toBe(0);
        expect(result.current.activeId).toBeNull();
    });
});

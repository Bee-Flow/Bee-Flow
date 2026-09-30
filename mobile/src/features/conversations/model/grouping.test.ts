/**
 * The conversation list's sections: pinned, then recency buckets, then agent
 * chats last under an honest "recent" heading.
 */

import type { ConversationSummary } from '@/features/chat';

import { groupConversations, type AgentChatRow } from './grouping';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const chat = (id: string, ageDays: number, pinned = false): ConversationSummary => ({
    id,
    title: id,
    pinned,
    created_at: '',
    updated_at: new Date(NOW - ageDays * DAY).toISOString(),
});

const agentChat = (id: string, ageDays: number): AgentChatRow => ({
    id,
    agent_id: 'a1',
    title: id,
    agent_name: 'Helper',
    agent_avatar: null,
    updated_at: new Date(NOW - ageDays * DAY).toISOString(),
});

describe('groupConversations', () => {
    it('is empty when there is nothing at all', () => {
        expect(groupConversations([], [], NOW)).toEqual([]);
    });

    it('puts pinned first, then today through older, then agent chats newest first', () => {
        const sections = groupConversations(
            [chat('p', 40, true), chat('t', 0.5), chat('y', 1.5), chat('w', 3), chat('m', 10), chat('o', 90)],
            [agentChat('old', 5), agentChat('new', 1)],
            NOW,
        );
        expect(sections.map((s) => [s.title, s.data.map((r) => r.id)])).toEqual([
            ['Pinned', ['p']],
            ['Today', ['t']],
            ['Yesterday', ['y']],
            ['This week', ['w']],
            ['This month', ['m']],
            ['Older', ['o']],
            ['Recent with agents', ['new', 'old']],
        ]);
    });

    it('leaves out empty buckets', () => {
        expect(groupConversations([chat('t', 0)], [], NOW).map((s) => s.title)).toEqual(['Today']);
    });
});

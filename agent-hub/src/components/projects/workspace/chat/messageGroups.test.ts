import { describe, expect, it } from 'vitest';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';
import { groupMessages, repliesToPrevious } from './messageGroups';

const msg = (id: string, minute: number, extra: Partial<TeamChatMessage> = {}): TeamChatMessage => ({
    id, seq: minute, authorKind: 'user', authorUserId: 'u1', agentId: null, content: id, mentions: [], replyTo: null,
    createdAt: `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`, editedAt: null, deleted: false, ...extra,
});

describe('repliesToPrevious', () => {
    it('marks a reply to the message right above it, across a change of author', () => {
        const groups = groupMessages([
            msg('a', 0),
            msg('b', 1, { authorKind: 'assistant', authorUserId: null, replyTo: 'a' }),
        ], []);
        expect([...repliesToPrevious(groups)]).toEqual(['b']);
    });

    it('keeps the quote when something else stands between', () => {
        const groups = groupMessages([
            msg('a', 0),
            msg('x', 1, { authorUserId: 'u2' }),
            msg('b', 2, { authorKind: 'assistant', authorUserId: null, replyTo: 'a' }),
        ], []);
        expect(repliesToPrevious(groups).size).toBe(0);
    });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TeamChatMessage } from '../../../../api/queries/projectChatTypes';
import { excerptOf, formatDayLabel, groupMessages, isNewDay, mainConversation, summarizeThreads, threadConversation } from './messageGroups';
import {
    findMentionQuery, insertMention, matchCandidates, mentions, resolveMentions, splitMentions, type MentionCandidate,
} from './mentions';

const ADA: MentionCandidate = { key: 'u-ada', kind: 'user', label: 'Ada Lovelace', token: 'Ada Lovelace', userId: 'u-ada' };
const BEN: MentionCandidate = { key: 'u-ben', kind: 'user', label: 'Ben Stone', token: 'Ben Stone', userId: 'u-ben' };
const AI: MentionCandidate = { key: 'ai', kind: 'ai', label: 'AI assistant', token: 'ai' };

describe('mentions', () => {
    it('finds the word being typed after an @, and nothing inside an e-mail address', () => {
        expect(findMentionQuery('Hi @ad', 6)).toEqual({ start: 3, query: 'ad' });
        expect(findMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
        expect(findMentionQuery('mail tom@example.org', 20)).toBeNull();
        expect(findMentionQuery('Hi @ada there', 13)).toBeNull();
    });

    it('matches on any word of a name', () => {
        expect(matchCandidates([ADA, BEN, AI], 'love').map(c => c.key)).toEqual(['u-ada']);
        expect(matchCandidates([ADA, BEN, AI], 'a').map(c => c.key)).toEqual(['u-ada', 'ai']);
        expect(matchCandidates([ADA, BEN, AI], '')).toHaveLength(3);
    });

    it('replaces the typed @word with the full name and puts the caret after it', () => {
        const at = findMentionQuery('Hi @ad', 6)!;
        expect(insertMention('Hi @ad', at, 6, 'Ada Lovelace')).toEqual({ text: 'Hi @Ada Lovelace ', caret: 17 });
        const mid = findMentionQuery('Hi @b and more', 5)!;
        expect(insertMention('Hi @b and more', mid, 5, 'Ben Stone').text).toBe('Hi @Ben Stone and more');
    });

    it('sends only the mentions the final text still carries', () => {
        expect(resolveMentions('Thanks @Ada Lovelace!', [ADA, BEN])).toEqual({ userIds: ['u-ada'], refs: [], asksAi: false });
        expect(resolveMentions('@ai what do you think', [AI, ADA])).toEqual({ userIds: [], refs: [], asksAi: true });
    });

    it('collects tagged documents and notebooks, and does not take them for a question to the AI', () => {
        const doc: MentionCandidate = { key: 'document:d1', kind: 'document', label: 'Budget 2026', token: 'Budget 2026', ref: { kind: 'document', id: 'd1' } };
        const nb: MentionCandidate = { key: 'notebook:n1', kind: 'notebook', label: 'Research', token: 'Research', ref: { kind: 'notebook', id: 'n1' } };
        expect(resolveMentions('See @Budget 2026 and @Research', [doc, nb])).toEqual({
            userIds: [], refs: [{ kind: 'document', id: 'd1' }, { kind: 'notebook', id: 'n1' }], asksAi: false,
        });
        expect(resolveMentions('See @Budget 2026', [doc, nb]).refs).toEqual([{ kind: 'document', id: 'd1' }]);
        const meeting: MentionCandidate = { key: 'meeting:m1', kind: 'meeting', label: 'Weekly sync', token: 'Weekly sync', ref: { kind: 'meeting', id: 'm1' } };
        expect(resolveMentions('As said in @Weekly sync', [meeting, doc])).toEqual({ userIds: [], refs: [{ kind: 'meeting', id: 'm1' }], asksAi: false });
        expect(mentions('email@ai.com', 'ai')).toBe(false);
    });

    it('splits text so known mentions can be painted', () => {
        expect(splitMentions('Hey @Ada Lovelace and @ai.', ['Ada Lovelace', 'ai'])).toEqual([
            { text: 'Hey ', mention: false },
            { text: '@Ada Lovelace', mention: true },
            { text: ' and ', mention: false },
            { text: '@ai', mention: true },
            { text: '.', mention: false },
        ]);
        expect(splitMentions('mail me at x@ai', ['ai'])).toEqual([{ text: 'mail me at x@ai', mention: false }]);
    });
});

describe('message groups', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 8, 29, 10, min)).toISOString();
    const m = (id: string, author: string | null, min: number, kind: 'user' | 'assistant' = 'user') => ({
        id, seq: Number(id.slice(1)), authorKind: kind, authorUserId: author, agentId: null, content: id,
        mentions: [], replyTo: null, createdAt: at(min), editedAt: null, deleted: false,
    });

    it('groups one author within five minutes, and starts a new group for the AI or after a pause', () => {
        const groups = groupMessages([
            m('m1', 'u-ada', 0), m('m2', 'u-ada', 3), m('m3', null, 4, 'assistant'), m('m4', 'u-ada', 5), m('m5', 'u-ada', 20),
        ], [{ clientMsgId: 'p', content: 'x', mentions: [], replyTo: null, askAi: false, authorUserId: 'u-ada', createdAt: at(21), status: 'sending' }]);
        expect(groups.map(g => g.items.length)).toEqual([2, 1, 1, 2]);
        expect(groups[3].items[1].type).toBe('pending');
    });

    it('cuts a long message to one line for a reply preview', () => {
        expect(excerptOf('a\n b   c')).toBe('a b c');
        expect(excerptOf('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    });
});

const msg = (id: string, extra: Partial<TeamChatMessage> = {}): TeamChatMessage => ({
    id, seq: 1, authorKind: 'user', authorUserId: 'u', agentId: null, content: id, mentions: [], replyTo: null,
    createdAt: '2026-10-01T10:00:00Z', editedAt: null, deleted: false, ...extra,
});

describe('threads', () => {
    const root = msg('root');
    const r1 = msg('r1', { threadId: 'root', createdAt: '2026-10-01T10:05:00Z' });
    const r2 = msg('r2', { threadId: 'root', createdAt: '2026-10-01T10:09:00Z' });
    const gone = msg('r3', { threadId: 'root', deleted: true });
    const other = msg('other');

    it('keeps replies out of the main conversation and counts them per thread', () => {
        const all = [root, r1, other, r2, gone];
        expect(mainConversation(all, []).messages.map(m => m.id)).toEqual(['root', 'other']);
        expect(summarizeThreads(all).get('root')).toEqual({ count: 2, lastAt: '2026-10-01T10:09:00Z' });
        expect(summarizeThreads(all).get('other')).toBeUndefined();
    });

    it('shows one thread as its root and its replies', () => {
        expect(threadConversation([root, r1, other, r2], [], 'root').messages.map(m => m.id)).toEqual(['root', 'r1', 'r2']);
    });
});

describe('days', () => {
    const now = new Date(2026, 9, 15, 12, 0);
    const labels = { today: 'Today', yesterday: 'Yesterday' };
    it('starts a new separator when the calendar day changes', () => {
        expect(isNewDay(new Date(2026, 9, 14, 23, 59).toISOString(), new Date(2026, 9, 15, 0, 1).toISOString())).toBe(true);
        expect(isNewDay(new Date(2026, 9, 15, 8, 0).toISOString(), new Date(2026, 9, 15, 9, 0).toISOString())).toBe(false);
        expect(isNewDay('garbage', new Date().toISOString())).toBe(false);
    });
    it('names today and yesterday, and dates the rest', () => {
        expect(formatDayLabel(new Date(2026, 9, 15, 9).toISOString(), 'en', labels, now)).toBe('Today');
        expect(formatDayLabel(new Date(2026, 9, 14, 9).toISOString(), 'en', labels, now)).toBe('Yesterday');
        expect(formatDayLabel(new Date(2026, 8, 1, 9).toISOString(), 'en', labels, now)).toMatch(/September/);
    });
});

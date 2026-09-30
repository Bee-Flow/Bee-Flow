// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { excerptOf, groupMessages } from './messageGroups';
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
        expect(resolveMentions('Thanks @Ada Lovelace!', [ADA, BEN])).toEqual({ userIds: ['u-ada'], asksAi: false });
        expect(resolveMentions('@ai what do you think', [AI, ADA])).toEqual({ userIds: [], asksAi: true });
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

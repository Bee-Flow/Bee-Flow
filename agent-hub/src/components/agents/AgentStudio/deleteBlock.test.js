// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { summariseDeleteBlock, blockHasFindings, USAGE_KINDS } from './deleteBlock';

describe('summariseDeleteBlock — "in use" and "could not check" are not the same answer', () => {
    it('reports found consumers per kind, in reading order', () => {
        const s = summariseDeleteBlock({
            rows: [
                { kind: 'automation', id: 'a1', foreign: false },
                { kind: 'automation', id: 'a2', foreign: false },
                { kind: 'app', id: null, foreign: true },
            ],
            counts: { automation: 2, app: 1 },
            unchecked: [],
            chat: { othersConversationCount: 0 },
        });
        expect(s.used.map((u) => u.kind)).toEqual(['automation', 'app']);
        expect(s.used[0].count).toBe(2);
        expect(s.used[1].foreignOnly).toBe(true);
        expect(s.unchecked).toEqual([]);
    });

    it('a count larger than the row tally wins — rows can be truncated', () => {
        // The wound: trusting the visible rows would tell somebody "1 automation"
        // while the server counted 40, and they would delete on that number.
        const s = summariseDeleteBlock({
            rows: [{ kind: 'automation', id: 'a1', foreign: false }],
            counts: { automation: 40 },
            unchecked: [],
            chat: { othersConversationCount: 0 },
        });
        expect(s.used[0].count).toBe(40);
    });

    it('an unreadable body reports EVERY kind as unchecked, never as empty', () => {
        for (const junk of [null, undefined, 'nope', 42, [], true]) {
            const s = summariseDeleteBlock(junk);
            expect(s.readable).toBe(false);
            expect(s.used).toEqual([]);
            expect(s.unchecked).toEqual([...USAGE_KINDS].sort((a, b) => USAGE_KINDS.indexOf(a) - USAGE_KINDS.indexOf(b)));
            expect(s.chatUnknown).toBe(true);
            expect(s.othersChats).toBeNull();
        }
    });

    it('an unchecked field that is not a list is itself unreadable — so all kinds are unchecked', () => {
        const s = summariseDeleteBlock({ rows: [], counts: {}, unchecked: 'automation', chat: { othersConversationCount: 0 } });
        expect(s.unchecked).toHaveLength(USAGE_KINDS.length);
    });

    it('rows that are not a list do not read as "no consumers"', () => {
        const s = summariseDeleteBlock({ rows: 'boom', unchecked: ['app'], chat: { othersConversationCount: 0 } });
        expect(s.used).toEqual([]);
        // rows unreadable and no counts object either: nothing was learned
        expect(s.readable).toBe(false);
        expect(s.unchecked).toEqual(['app']);
    });

    it('chat: null means the count could not be read, and is not zero', () => {
        const s = summariseDeleteBlock({ rows: [], counts: {}, unchecked: [], chat: null });
        expect(s.chatUnknown).toBe(true);
        expect(s.othersChats).toBeNull();
    });

    it('a chat object without a finite count is also unknown', () => {
        for (const bad of [{}, { othersConversationCount: null }, { othersConversationCount: 'lots' }]) {
            const s = summariseDeleteBlock({ rows: [], counts: {}, unchecked: [], chat: bad });
            expect(s.chatUnknown).toBe(true);
        }
    });

    it('a real chat count of zero is known, not unknown', () => {
        const s = summariseDeleteBlock({ rows: [], counts: {}, unchecked: [], chat: { othersConversationCount: 0 } });
        expect(s.chatUnknown).toBe(false);
        expect(s.othersChats).toBe(0);
    });

    it('a kind the server adds later is reported under its own name, not dropped', () => {
        const s = summariseDeleteBlock({
            rows: [{ kind: 'newthing', id: 'x', foreign: false }],
            counts: { newthing: 1 },
            unchecked: [],
            chat: { othersConversationCount: 0 },
        });
        expect(s.used.map((u) => u.kind)).toEqual(['newthing']);
    });

    it('zero and negative counts are not consumers', () => {
        const s = summariseDeleteBlock({ rows: [], counts: { app: 0, task: -3 }, unchecked: [], chat: { othersConversationCount: 0 } });
        expect(s.used).toEqual([]);
    });
});

describe('blockHasFindings', () => {
    it('is false when the refusal was purely "could not check"', () => {
        expect(blockHasFindings(summariseDeleteBlock({
            rows: [], counts: {}, unchecked: ['app', 'webpage'], chat: null,
        }))).toBe(false);
    });

    it('is true when somebody else has history, even with no consumers', () => {
        expect(blockHasFindings(summariseDeleteBlock({
            rows: [], counts: {}, unchecked: [], chat: { othersConversationCount: 3 },
        }))).toBe(true);
    });

    it('is false for an unreadable summary', () => {
        expect(blockHasFindings(summariseDeleteBlock(null))).toBe(false);
        expect(blockHasFindings(null)).toBe(false);
    });
});

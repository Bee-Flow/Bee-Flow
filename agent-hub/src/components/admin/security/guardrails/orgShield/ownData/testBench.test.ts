// @vitest-environment node
import { describe, it, expect } from 'vitest';

import type { Sentence } from './ownDataModel';
import { checkPattern, inferPattern } from './patternCheck';
import {
    addGold, findAll, foundSpansOf, goldSentenceCount, isMarked, makeSentence, markAllOccurrences,
    normaliseSpans, removeGold, scoreSentence, sentenceVerdict, summarise, wireSentences,
} from './testBench';

/**
 * The test bench's pure half. Two things matter most: the wire keeps "not
 * marked" and "nothing should be hidden" apart, and local rescoring after a
 * right/wrong choice follows the server's rule (a gold span is found when at
 * least half of it is covered).
 */

const s = (text: string, gold?: { start: number; end: number }[]): Sentence => ({
    id: `s_${text.length}`, text, origin: 'own', ...(gold ? { gold } : {}),
});

describe('sentences and gold', () => {
    it('starts a new sentence unmarked, not as "nothing should be hidden"', () => {
        const fresh = makeSentence('Project Falcon starts Monday');
        expect(fresh.id).toMatch(/^s_[0-9a-f]{8}$/);
        expect(isMarked(fresh)).toBe(false);
        expect(fresh).not.toHaveProperty('gold');
        expect(makeSentence('x', 'nearmiss', []).gold).toEqual([]);
    });

    it('sends gold only for marked sentences', () => {
        const wire = wireSentences([s('a b'), s('c d', []), s('e f', [{ start: 0, end: 1 }])]);
        expect(wire[0]).not.toHaveProperty('gold');
        expect(wire[1].gold).toEqual([]);
        expect(wire[2].gold).toEqual([{ start: 0, end: 1 }]);
    });

    it('normalises spans: sorted, clamped, merged, never empty', () => {
        expect(normaliseSpans([{ start: 5, end: 9 }, { start: 0, end: 3 }, { start: 2, end: 6 }, { start: 9, end: 9 }, { start: 8, end: 40 }], 12))
            .toEqual([{ start: 0, end: 12 }]);
        expect(normaliseSpans([{ start: 4, end: 6 }, { start: 0, end: 2 }], 10)).toEqual([{ start: 0, end: 2 }, { start: 4, end: 6 }]);
    });

    it('refuses a sixth mark rather than dropping one silently', () => {
        const text = 'a b c d e f g';
        let cur: Sentence = s(text, []);
        for (let i = 0; i < 5; i++) cur = addGold(cur, { start: i * 2, end: i * 2 + 1 }).sentence;
        const res = addGold(cur, { start: 10, end: 11 });
        expect(res.capped).toBe(true);
        expect(res.sentence.gold).toHaveLength(5);
    });

    it('turns "not this" on an unmarked sentence into "nothing should be hidden"', () => {
        expect(removeGold(s('abc'), { start: 0, end: 1 }).gold).toEqual([]);
        expect(removeGold(s('abc def', [{ start: 0, end: 3 }, { start: 4, end: 7 }]), { start: 1, end: 2 }).gold).toEqual([{ start: 4, end: 7 }]);
    });

    it('marks every occurrence of typed text, case-insensitively', () => {
        expect(findAll('KL-1 and kl-1 and KL-2', 'kl-1')).toEqual([{ start: 0, end: 4 }, { start: 9, end: 13 }]);
        const res = markAllOccurrences(s('Falcon and falcon'), 'FALCON');
        expect(res.count).toBe(2);
        expect(res.sentence.gold).toEqual([{ start: 0, end: 6 }, { start: 11, end: 17 }]);
        expect(markAllOccurrences(s('abc'), 'zzz').count).toBe(0);
    });
});

describe('scoring', () => {
    it('finds a gold span when at least half of it is covered', () => {
        const sent = s('code KL-12345 here', [{ start: 5, end: 13 }]);
        expect(scoreSentence(sent, [{ start: 5, end: 13 }])).toEqual([{ start: 5, end: 13, kind: 'hit' }]);
        expect(scoreSentence(sent, [{ start: 5, end: 9 }])).toEqual([{ start: 5, end: 13, kind: 'hit', partial: true }]);
        expect(scoreSentence(sent, [{ start: 5, end: 8 }])).toEqual([{ start: 5, end: 13, kind: 'missed', partial: true }]);
        expect(scoreSentence(sent, [])).toEqual([{ start: 5, end: 13, kind: 'missed' }]);
    });

    it('calls a find outside every gold span a false alarm on a marked sentence', () => {
        const marks = scoreSentence(s('KL-1 and KL-2', [{ start: 0, end: 4 }]), [{ start: 0, end: 4 }, { start: 9, end: 13 }]);
        expect(marks.map(m => m.kind)).toEqual(['hit', 'false_alarm']);
        expect(sentenceVerdict(marks)).toEqual({ verdict: 'false_alarm', missed: 0, falseAlarms: 1 });
        // A near miss: nothing should be hidden, so any find is wrong.
        expect(scoreSentence(s('KL-1', []), [{ start: 0, end: 4 }])[0].kind).toBe('false_alarm');
    });

    it('calls a find on an unmarked sentence just a find', () => {
        expect(scoreSentence(s('KL-1'), [{ start: 0, end: 4 }])).toEqual([{ start: 0, end: 4, kind: 'found' }]);
    });

    it('summarises only marked sentences the run scored', () => {
        const sentences = [
            s('KL-1 x', [{ start: 0, end: 4 }]),
            s('nothing', []),
            s('unmarked KL-9'),
            s('not in run', [{ start: 0, end: 3 }]),
        ];
        sentences[1].id = 'b';
        sentences[2].id = 'c';
        sentences[3].id = 'd';
        const run = { found: { [sentences[0].id]: [{ start: 0, end: 4 }], b: [{ start: 0, end: 7 }], c: [{ start: 9, end: 13 }] }, fingerprint: '', engine: 'local' as const };
        expect(summarise(sentences, run)).toEqual({ found: 1, total: 1, falseAlarms: 1, sentences: 2 });
        expect(summarise(sentences, null)).toEqual({ found: 0, total: 0, falseAlarms: 0, sentences: 0 });
        expect(goldSentenceCount(sentences)).toBe(2);
    });

    it('reads the found spans out of a server result', () => {
        expect(foundSpansOf([
            { start: 0, end: 2, kind: 'hit' }, { start: 3, end: 4, kind: 'missed' },
            { start: 5, end: 6, kind: 'false_alarm' }, { start: 7, end: 8, kind: 'found' },
        ])).toEqual([{ start: 0, end: 2 }, { start: 5, end: 6 }, { start: 7, end: 8 }]);
    });
});

describe('patterns in the browser', () => {
    it('infers the shared shape of real examples', () => {
        expect(inferPattern(['KL-12345', 'KL-83920', 'KL-10473'])).toBe('\\bKL-\\d{5}\\b');
        expect(inferPattern(['PN-1234567', 'PN-7654321'])).toBe('\\bPN-\\d{7}\\b');
        expect(inferPattern(['AB12', 'XY345'])).toBe('\\b[A-Z]{2}\\d{2,3}\\b');
        expect(inferPattern(['KL-1', '12-KL'])).toBe('');
        expect(inferPattern([])).toBe('');
    });

    it('checks a pattern against whole examples', () => {
        expect(checkPattern('KL-\\d{5}', ['KL-12345', 'KL-1234'])).toEqual({ ok: true, matched: 1, total: 2, misses: ['KL-1234'] });
        expect(checkPattern('(', ['x'])).toMatchObject({ ok: false, reason: 'invalid' });
        expect(checkPattern('a*', [])).toMatchObject({ ok: false, reason: 'invalid' });
        expect(checkPattern('', [])).toMatchObject({ ok: false, reason: 'empty' });
        expect(checkPattern('x'.repeat(301), [])).toMatchObject({ ok: false, reason: 'too_long' });
    });
});

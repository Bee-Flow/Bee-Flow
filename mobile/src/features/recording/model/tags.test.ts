import {
    audioCacheName,
    effectiveDuration,
    fractionAt,
    nextRate,
    progressOf,
    skipTarget,
} from './player';
import { MAX_TAG_LENGTH, MAX_TAGS, addTags, parseTagInput, removeTag, sameTags, suggestedTags, withTag } from './tags';

describe('tags', () => {
    it('splits typed input on commas and trims', () => {
        expect(parseTagInput(' sales, q3 ,, ')).toEqual(['sales', 'q3']);
        expect(parseTagInput('x'.repeat(100))[0]).toHaveLength(MAX_TAG_LENGTH);
    });

    it('adds without duplicates, and never past the server cap', () => {
        expect(addTags(['sales'], 'sales, q3')).toEqual(['sales', 'q3']);
        const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
        expect(addTags(full, 'one more')).toHaveLength(MAX_TAGS);
        expect(withTag(['a'], 'b, c')).toEqual(['a', 'b, c']);
        expect(withTag(['a'], '  ')).toEqual(['a']);
    });

    it('removes, compares and suggests', () => {
        expect(removeTag(['a', 'b'], 'a')).toEqual(['b']);
        expect(sameTags(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameTags(['a', 'b'], ['b', 'a'])).toBe(false);
        const vocabulary = [
            { tag: 'b', count: 1 },
            { tag: 'a', count: 5 },
            { tag: 'c', count: 5 },
        ];
        expect(suggestedTags(vocabulary, ['c'])).toEqual(['a', 'b']);
    });
});

describe('the player', () => {
    it('cycles the web speeds', () => {
        expect(nextRate(1)).toBe(1.25);
        expect(nextRate(2)).toBe(1);
        expect(nextRate(3)).toBe(1);
    });

    it("trusts the stored length when the file's is unknown", () => {
        expect(effectiveDuration(120, 300)).toBe(120);
        expect(effectiveDuration(0, 300)).toBe(300);
        expect(effectiveDuration(Number.POSITIVE_INFINITY, 300)).toBe(300);
        expect(effectiveDuration(Number.NaN, null)).toBe(0);
    });

    it('keeps the bar and the skips inside the recording', () => {
        expect(fractionAt(50, 200)).toBe(0.25);
        expect(fractionAt(-5, 200)).toBe(0);
        expect(fractionAt(5, 0)).toBe(0);
        expect(progressOf(30, 60)).toBe(0.5);
        expect(progressOf(30, 0)).toBe(0);
        expect(skipTarget(5, -10, 60)).toBe(0);
        expect(skipTarget(55, 10, 60)).toBe(60);
        expect(skipTarget(55, 10, 0)).toBe(65);
    });

    it('caches one file per note', () => {
        expect(audioCacheName('m1')).toBe('meeting-audio-m1');
    });
});

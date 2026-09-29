// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mergeSpans, buildRuns, nextManualId } from './dlpFindingsState';

describe('mergeSpans', () => {
    it('keeps disjoint auto findings and manual spans as-is, sorted by offset', () => {
        const auto = [{ id: 'pii_0', offset: 10, length: 5, category: 'Person', source: 'pii', confidenceBand: 'high', text: 'Alice' }];
        const manual = [{ id: 'manual_1', offset: 0, length: 5, text: 'hello' }];
        const merged = mergeSpans(auto, manual);
        expect(merged.map(s => s.offset)).toEqual([0, 10]);
        expect(merged[0].source).toBe('manual');
        expect(merged[0].category).toBe('UserMarked');
        expect(merged[1].source).toBe('pii');
    });

    it('collapses an overlapping manual mark into the auto finding, manual wins the label', () => {
        // Auto found "Alice" at [6,11); user selects a wider "hello Alice" at [0,11).
        const auto = [{ id: 'pii_0', offset: 6, length: 5, category: 'Person', source: 'pii', confidenceBand: 'high', text: 'Alice' }];
        const manual = [{ id: 'manual_1', offset: 0, length: 11, text: 'hello Alice' }];
        const merged = mergeSpans(auto, manual);
        expect(merged).toHaveLength(1);
        expect(merged[0].offset).toBe(0);
        expect(merged[0].length).toBe(11);
        // A manual correction should win the label over the auto hit it subsumes.
        expect(merged[0].source).toBe('manual');
    });

    it('drops spans with unusable offsets rather than crashing', () => {
        const auto = [{ id: 'pii_0', offset: -1, length: 5, category: 'Person', source: 'pii' }];
        expect(mergeSpans(auto, [])).toEqual([]);
    });

    it('returns [] for no findings and no manual spans', () => {
        expect(mergeSpans([], [])).toEqual([]);
        expect(mergeSpans(undefined, undefined)).toEqual([]);
    });
});

describe('buildRuns', () => {
    it('splits text into alternating plain-text and span runs in offset order', () => {
        const text = 'hello Alice, call 0612345678';
        const spans = [
            { id: 'a', offset: 6, length: 5, category: 'Person', source: 'pii', text: 'Alice' },
            { id: 'b', offset: 18, length: 10, category: 'PhoneNumber', source: 'pii', text: '0612345678' },
        ];
        const runs = buildRuns(text, spans);
        // Runs must reconstruct the original string exactly — offset math depends on this.
        expect(runs.map(r => r.value).join('')).toBe(text);
        expect(runs[0]).toEqual({ type: 'text', value: 'hello ' });
        expect(runs[1]).toMatchObject({ type: 'span', value: 'Alice', id: 'a' });
        expect(runs[2]).toEqual({ type: 'text', value: ', call ' });
        expect(runs[3]).toMatchObject({ type: 'span', value: '0612345678', id: 'b' });
    });

    it('a span at the very start/end produces no empty leading/trailing text run', () => {
        const runs = buildRuns('Alice', [{ id: 'a', offset: 0, length: 5, category: 'Person', source: 'pii' }]);
        expect(runs).toHaveLength(1);
        expect(runs[0].type).toBe('span');
    });

    it('no spans → the whole string is one text run', () => {
        expect(buildRuns('plain text', [])).toEqual([{ type: 'text', value: 'plain text' }]);
    });
});

describe('nextManualId', () => {
    it('returns a distinct id on every call', () => {
        const ids = new Set([nextManualId(), nextManualId(), nextManualId()]);
        expect(ids.size).toBe(3);
    });
});

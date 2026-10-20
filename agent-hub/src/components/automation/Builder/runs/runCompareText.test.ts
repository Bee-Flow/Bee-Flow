import { describe, it, expect } from 'vitest';
import type { FileSummary, StepCompare } from '../../../../api/queries/automation/runChecks';
import { formatBytes, modeText, partChanges, softChipText, stepVerdictText, summaryLine, verdictText } from './runCompareText';

// The fallback is the English; params fill {name} like the real t().
const t = (_key: string | undefined, fallback?: string | Record<string, unknown>, params?: Record<string, unknown>) => {
    const text = typeof fallback === 'string' ? fallback : '';
    return text.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));
};

const step = (over: Partial<StepCompare>): StepCompare => ({
    key: 'k', stepId: 's', stepType: null, parentStepId: null,
    a: { present: true, status: 'success' }, b: { present: true, status: 'success' },
    verdict: 'same', softReason: null, kind: 'json', changes: [], changesTruncated: false, files: [], ...over,
});

describe('verdictText', () => {
    it('names the three overall verdicts', () => {
        expect(verdictText(t, { verdict: 'same', steps: [] })).toEqual({ text: 'Same result', tone: 'good' });
        expect(verdictText(t, { verdict: 'changed', steps: [] })).toEqual({ text: 'Different', tone: 'bad' });
    });

    it('says what is soft when it is only AI, only simulated, or both', () => {
        const ai = step({ verdict: 'soft', softReason: 'ai' });
        const sim = step({ verdict: 'soft', softReason: 'simulated' });
        expect(verdictText(t, { verdict: 'soft', steps: [ai] }).text).toBe('Only AI answers differ');
        expect(verdictText(t, { verdict: 'soft', steps: [sim, sim] }).text).toBe('Only simulated steps differ');
        expect(verdictText(t, { verdict: 'soft', steps: [ai, sim] }).text).toBe('Only expected differences');
        expect(verdictText(t, { verdict: 'soft', steps: [] })).toEqual({ text: 'Only expected differences', tone: 'soft' });
    });
});

describe('step wording', () => {
    it('words every step verdict', () => {
        expect(stepVerdictText(t, 'only_a')).toBe('Only in run A');
        expect(stepVerdictText(t, 'only_b')).toBe('Only in run B');
        expect(stepVerdictText(t, 'soft')).toBe('Differs, as expected');
        expect(stepVerdictText(t, 'status_changed')).toBe('Different outcome');
        expect(stepVerdictText(t, 'not_comparable')).toBe('Cannot compare');
        expect(stepVerdictText(t, 'changed')).toBe('Different');
        expect(stepVerdictText(t, 'same')).toBe('Same');
    });

    it('gives a chip only for a reason it knows', () => {
        expect(softChipText(t, 'ai')).toBe('AI answer: may vary between runs');
        expect(softChipText(t, 'simulated')).toBe('Simulated in a test run');
        expect(softChipText(t, null)).toBeNull();
    });

    it('counts differences, expected variance and the rest', () => {
        const line = summaryLine(t, { same: 5, changed: 1, soft: 2, onlyA: 1, onlyB: 0, notComparable: 0 });
        expect(line).toBe('2 different · 2 may vary · 5 the same');
        expect(summaryLine(t, { same: 0, changed: 0, soft: 0, onlyA: 0, onlyB: 0, notComparable: 3 })).toContain('3 not comparable');
    });

    it('tells a test run from a live one', () => {
        expect(modeText(t, 'dry_run', null)).toBe('test run, nothing sent');
        expect(modeText(t, 'live', 'dry_run')).toBe('test run, nothing sent');
        expect(modeText(t, 'live', 'form')).toBe('live run');
    });

    it('formats sizes', () => {
        expect(formatBytes(null)).toBe('');
        expect(formatBytes(800)).toBe('800 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    });
});

describe('partChanges', () => {
    const file = (parts: FileSummary['parts']): FileSummary => ({ name: 'f', mime: 'm', size: 1, sha256: null, parts });
    const slide = (index: number, over: Record<string, unknown> = {}) => ({
        kind: 'slide', index, title: `Slide ${index}`, name: null, rows: null, cols: null, textChars: 100, textHash: 'aa', ...over,
    });

    it('lists only what changed, per slide', () => {
        const out = partChanges(t, file([slide(0), slide(1)]), file([slide(0), slide(1, { title: 'New title', textChars: 80 })]));
        expect(out).toHaveLength(1);
        expect(out[0].label).toBe('Slide 2 (New title)');
        expect(out[0].details).toEqual([
            { field: 'Title', was: 'Slide 1', becomes: 'New title' },
            { field: 'Text length', was: '100', becomes: '80' },
        ]);
    });

    it('reports added and removed parts and sheet shape', () => {
        const sheet = (index: number, rows: number) => ({ kind: 'sheet', index, title: null, name: `S${index}`, rows, cols: 3, textChars: null, textHash: null });
        const out = partChanges(t, file([sheet(0, 10), sheet(1, 4)]), file([sheet(0, 12)]));
        expect(out.map(p => [p.label, p.status])).toEqual([['Sheet 1 (S0)', 'changed'], ['Sheet 2 (S1)', 'removed']]);
        expect(out[0].details).toEqual([{ field: 'Rows', was: '10', becomes: '12' }]);
        expect(partChanges(t, null, file([sheet(0, 1)]))[0].status).toBe('added');
    });

    it('notices other words of the same length by the hash', () => {
        const out = partChanges(t, file([slide(0)]), file([slide(0, { textHash: 'bb' })]));
        expect(out[0].details[0].field).toBe('Text');
    });

    it('is quiet when nothing changed', () => {
        expect(partChanges(t, file([slide(0)]), file([slide(0)]))).toEqual([]);
        expect(partChanges(t, null, null)).toEqual([]);
    });
});

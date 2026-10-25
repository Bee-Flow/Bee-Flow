import { describe, it, expect } from 'vitest';
import { parseCounts, countFor } from './useComplianceCounts';

describe('useComplianceCounts — parse and lookup', () => {
    it('parseCounts: only a plain object is counts; the nav-test [] mock and junk are null', () => {
        expect(parseCounts({ attention_open: 3 })).toEqual({ attention_open: 3 });
        expect(parseCounts([])).toBeNull();
        expect(parseCounts(null)).toBeNull();
        expect(parseCounts('nope')).toBeNull();
        expect(parseCounts(undefined)).toBeNull();
    });

    it('countFor: dotted paths, undefined for anything unknown, a real 0 stays 0', () => {
        const c = { dsr: { open: 0, overdue: 2 }, frameworks: { gdpr: { score: 79 } }, last_run: { at: 'x' }, evidence: { chain_ok: true } };
        expect(countFor(c, 'dsr.open')).toBe(0);
        expect(countFor(c, 'dsr.overdue')).toBe(2);
        expect(countFor(c, 'frameworks.gdpr.score')).toBe(79);
        expect(countFor(c, 'frameworks.cra.score')).toBeUndefined();
        expect(countFor(c, 'frameworks.gdpr')).toEqual({ score: 79 });
        expect(countFor(c, 'last_run.at')).toBe('x');
        expect(countFor(c, 'evidence.chain_ok')).toBe(true);
        expect(countFor(null, 'dsr.open')).toBeUndefined();
        expect(countFor(c, '')).toBeUndefined();
        expect(countFor({ x: NaN }, 'x')).toBeUndefined();
        expect(countFor({ x: null }, 'x')).toBeUndefined();
    });
});

import { describe, it, expect } from 'vitest';
import { ladderTarget } from './ladderTarget';

describe('ladderTarget', () => {
    it('turns a per-automation row id into the record the ladder loads by', () => {
        expect(ladderTarget('a1', 'Intake bot')).toEqual({ id: 'a1', title: 'Intake bot' });
        expect(ladderTarget('a1')).toEqual({ id: 'a1' });
    });
    it('passes a record through and drops an empty target', () => {
        const rec = { id: 'g1', name: 'Agent' };
        expect(ladderTarget(rec, 'ignored')).toBe(rec);
        expect(ladderTarget(null)).toBeNull();
        expect(ladderTarget('')).toBeNull();
    });
});

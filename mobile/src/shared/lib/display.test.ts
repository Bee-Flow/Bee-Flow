import { absoluteDate, humanise } from './display';

describe('humanise', () => {
    it('sentence-cases snake and kebab case', () => {
        expect(humanise('awaiting_user')).toBe('Awaiting user');
        expect(humanise('glass-dark')).toBe('Glass dark');
        expect(humanise('org__admin')).toBe('Org admin');
    });

    it('answers a dash for nothing', () => {
        expect(humanise(null)).toBe('—');
        expect(humanise(undefined)).toBe('—');
        expect(humanise('')).toBe('—');
    });
});

describe('absoluteDate', () => {
    it('formats a real date with the year', () => {
        expect(absoluteDate('2026-03-12T10:00:00Z')).toMatch(/2026/);
    });

    it('answers a dash for nothing or nonsense', () => {
        expect(absoluteDate(null)).toBe('—');
        expect(absoluteDate('not a date')).toBe('—');
    });
});

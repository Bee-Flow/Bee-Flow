import { compactNumber, currency, fractionOfLimit, num, shortDay, shortModel } from './format';

describe('num', () => {
    it('reads Postgres aggregates that arrive as strings', () => {
        expect(num('1423')).toBe(1423);
        expect(num('18.4402')).toBeCloseTo(18.4402);
        expect(num(7)).toBe(7);
    });

    it('answers 0 for nothing or nonsense', () => {
        expect(num(null)).toBe(0);
        expect(num(undefined)).toBe(0);
        expect(num('abc')).toBe(0);
    });
});

describe('compactNumber', () => {
    it('abbreviates thousands and millions', () => {
        expect(compactNumber(1_200_000)).toBe('1.2M');
        expect(compactNumber('3400')).toBe('3.4K');
        expect(compactNumber(942)).toBe((942).toLocaleString());
    });
});

describe('currency', () => {
    it('shows two decimals, and three below a cent rather than "€0.00"', () => {
        expect(currency('18.4402')).toBe('€18.44');
        expect(currency(0.004)).toBe('€0.004');
        expect(currency(0)).toBe('€0.00');
    });
});

describe('shortModel', () => {
    it('drops the provider prefix and the dated snapshot', () => {
        expect(shortModel('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
        expect(shortModel('anthropic/claude-x')).toBe('claude-x');
        expect(shortModel(null)).toBe('Unknown');
    });
});

describe('shortDay', () => {
    it('keeps a period it cannot read', () => {
        expect(shortDay('not-a-day')).toBe('not-a-day');
        expect(shortDay('2026-03-02')).not.toBe('2026-03-02');
    });
});

describe('fractionOfLimit', () => {
    it('treats a null or zero limit as no limit, never as a full bar', () => {
        expect(fractionOfLimit(10, null)).toBeNull();
        expect(fractionOfLimit(10, 0)).toBeNull();
    });

    it('clamps to 0..1', () => {
        expect(fractionOfLimit('50', 100)).toBe(0.5);
        expect(fractionOfLimit(500, 100)).toBe(1);
    });
});

import { describe, expect, it } from 'vitest';
import { costLimitToInput, parseCostLimitInput } from './costLimitInput';

describe('parseCostLimitInput', () => {
    it('reads empty as no limit', () => {
        expect(parseCostLimitInput('')).toBeNull();
        expect(parseCostLimitInput('  ')).toBeNull();
    });
    it('reads a positive amount, with a point or a comma', () => {
        expect(parseCostLimitInput('25')).toBe(25);
        expect(parseCostLimitInput('12,5')).toBe(12.5);
    });
    it('refuses zero, negative and text', () => {
        for (const bad of ['0', '-3', 'abc', '1e999']) expect(parseCostLimitInput(bad)).toBeUndefined();
    });
});

describe('costLimitToInput', () => {
    it('shows a stored amount and nothing for no limit', () => {
        expect(costLimitToInput(7.5)).toBe('7.5');
        expect(costLimitToInput(null)).toBe('');
        expect(costLimitToInput(undefined)).toBe('');
        expect(costLimitToInput(0)).toBe('');
    });
});

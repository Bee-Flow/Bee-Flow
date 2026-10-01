import { describe, expect, it } from 'vitest';
import { readableFieldName } from './fieldHandle';

describe('readableFieldName — a field as the step drawer names it', () => {
    it('keeps a name in words', () => {
        expect(readableFieldName('Subject line')).toBe('Subject line');
        expect(readableFieldName('  E-mail   of customer ')).toBe('E-mail of customer');
        expect(readableFieldName('New invoice received')).toBe('New invoice received');
        expect(readableFieldName('Total.amount (EUR)')).toBe('Total.amount (EUR)');
    });

    it('drops anything with a path or {{ }} in it, and nothing', () => {
        expect(readableFieldName('From: {{trigger.output.from}}')).toBeNull();
        expect(readableFieldName('field (e.g. steps.step1.output.total)')).toBeNull();
        expect(readableFieldName('trigger.output.subject')).toBeNull();
        expect(readableFieldName('item.amount')).toBeNull();
        expect(readableFieldName('steps["s1"].output')).toBeNull();
        expect(readableFieldName('')).toBeNull();
        expect(readableFieldName(null)).toBeNull();
        expect(readableFieldName(undefined)).toBeNull();
    });
});

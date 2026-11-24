/**
 * An item's goal on the phone: read from the server's answer (untrusted, so the reader is total), and shown as one
 * line with its count, or "not measured yet".
 */

import type { TranslateFn } from '@/core/i18n';

import { goalLabel } from './goal';
import { readGoalLine } from '../api/readers';

const t: TranslateFn = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? ''));

describe('an item\'s goal', () => {
    it('reads the sentence and the latest count, and nothing without a goal', () => {
        expect(readGoalLine({ goal: { sentence: 'Every supplier mail answered in two days', count: { met: 46, total: 49 } } }))
            .toEqual({ sentence: 'Every supplier mail answered in two days', met: 46, total: 49 });
        expect(readGoalLine({ goal: null })).toBeNull();
        expect(readGoalLine({ goal: { sentence: '' } })).toBeNull();
        expect(readGoalLine('nonsense')).toBeNull();
        expect(readGoalLine({ goal: { sentence: 'Quotes followed up', count: { met: 'many' } } })).toEqual({ sentence: 'Quotes followed up', met: null, total: null });
    });

    it('reads as one line with its count, or says it is not measured yet', () => {
        expect(goalLabel({ sentence: 'Every supplier mail answered', met: 46, total: 49 }, t)).toBe('Goal: Every supplier mail answered · 46 of 49');
        expect(goalLabel({ sentence: 'Quotes followed up', met: null, total: null }, t)).toBe('Goal: Quotes followed up · not measured yet');
    });
});

/**
 * The two definition helpers: a schedule edit writes the DEFINITION (the
 * columns are derived from it server-side), and a strict activation refusal
 * is read down to the lines that say which step is wrong.
 */

import { ApiError } from '@/core/api/client';

import { activationDetails, withSchedule } from './definition';
import type { AutomationDefinition } from './types';

describe('withSchedule', () => {
    it('patches the trigger without touching the rest, or the original', () => {
        const definition: AutomationDefinition = {
            trigger: { id: 't1', kind: 'manual' },
            steps: [{ id: 's1' }],
        };
        const next = withSchedule(definition, '0 9 * * 1', 'Europe/Amsterdam');
        expect(next.trigger).toEqual({
            id: 't1',
            kind: 'schedule',
            schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' },
        });
        expect(next.steps).toBe(definition.steps);
        expect(definition.trigger?.kind).toBe('manual');
    });

    it('adds a trigger to a definition that had none', () => {
        expect(withSchedule({}, '0 * * * *', 'UTC').trigger).toEqual({
            kind: 'schedule',
            schedule: { cron: '0 * * * *', tz: 'UTC' },
        });
    });
});

describe('activationDetails', () => {
    const refusal = (body: unknown) => new ApiError('Invalid definition', { status: 400, body });

    it('reads sentences and `message` objects, skipping anything else', () => {
        const error = refusal({ details: ['Step 2 has no tool', { message: 'Step 3 is empty' }, { code: 7 }, ''] });
        expect(activationDetails(error)).toEqual(['Step 2 has no tool', 'Step 3 is empty']);
    });

    it('keeps at most six lines', () => {
        const error = refusal({ details: Array.from({ length: 9 }, (_, i) => `line ${i}`) });
        expect(activationDetails(error)).toHaveLength(6);
    });

    it('has nothing to say about an error that is not a refusal with details', () => {
        expect(activationDetails(new Error('offline'))).toEqual([]);
        expect(activationDetails(refusal(null))).toEqual([]);
        expect(activationDetails(refusal({ details: 'nope' }))).toEqual([]);
    });
});

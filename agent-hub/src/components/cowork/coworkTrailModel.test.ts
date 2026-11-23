// How an entry of an item's trail reads (./coworkTrailModel.ts).
import { describe, expect, it } from 'vitest';
import { changedWords, trailLine } from './coworkTrailModel';
import { englishT as t } from './coworkPlan.fixture';
import type { TrailEntry } from '@/api/coworkTrail';

const entry = (over: Partial<TrailEntry>): TrailEntry => ({ action: 'cowork.updated', at: null, byYou: true, changed: [], values: {}, ...over });

describe('trailLine', () => {
    it('says who did what, in words', () => {
        expect(trailLine(entry({ action: 'cowork.created' }), t)).toBe('You created this work');
        expect(trailLine(entry({ action: 'cowork.plan_approved', byYou: false }), t)).toBe('Someone else approved the plan');
        expect(trailLine(entry({ action: 'cowork.toggled', values: { isActive: false } }), t)).toBe('You switched it off');
        expect(trailLine(entry({ action: 'cowork.toggled', values: {} }), t)).toBe('You switched it on');
    });

    it('names the fields a change touched, each once, and an action it does not know in plain words', () => {
        expect(trailLine(entry({ changed: ['repeatInterval', 'timeOfDay', 'prompt'] }), t)).toBe('You changed the schedule, the brief');
        expect(trailLine(entry({ changed: [] }), t)).toBe('You changed something');
        expect(trailLine(entry({ action: 'cowork.something_new' }), t)).toBe('You something new');
    });
});

describe('changedWords', () => {
    it('keeps a field it has no word for as its name', () => {
        expect(changedWords(['colour'], t)).toBe('colour');
    });
});

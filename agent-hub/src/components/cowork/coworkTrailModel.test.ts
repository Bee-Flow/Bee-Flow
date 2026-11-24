// How an entry of a task's change history reads (./coworkTrailModel.ts).
import { describe, expect, it } from 'vitest';
import { changedWords, trailLine } from './coworkTrailModel';
import { englishT as t } from './coworkPlan.fixture';
import type { TrailEntry } from '@/api/coworkTrail';

const entry = (over: Partial<TrailEntry>): TrailEntry => ({ action: 'cowork.updated', at: null, byYou: true, changed: [], values: {}, ...over });

describe('trailLine', () => {
    it('says who did what, in words', () => {
        expect(trailLine(entry({ action: 'cowork.created' }), t)).toBe('You created this task');
        expect(trailLine(entry({ action: 'cowork.plan_approved', byYou: false }), t)).toBe('Someone else approved the steps');
        expect(trailLine(entry({ action: 'cowork.toggled', values: { isActive: false } }), t)).toBe('You switched it off');
        expect(trailLine(entry({ action: 'cowork.toggled', values: { isActive: true } }), t)).toBe('You switched it on');
        // The server records a switch without where it ended: never "on" for what may have been a pause.
        expect(trailLine(entry({ action: 'cowork.toggled', values: {} }), t)).toBe('You paused or resumed it');
    });

    it('names Cowork, not someone else, for a fix it made by itself', () => {
        expect(trailLine(entry({ action: 'cowork.plan_auto_fixed', byYou: false, byCowork: true }), t))
            .toBe('Cowork fixed a step that was reading the wrong field (Cowork did this by itself; it can be undone)');
    });

    it('names the fields a change touched, each once, and an action it does not know in plain words', () => {
        expect(trailLine(entry({ changed: ['repeatInterval', 'timeOfDay', 'prompt'] }), t)).toBe('You changed the schedule, the sentence');
        expect(trailLine(entry({ changed: [] }), t)).toBe('You changed something');
        expect(trailLine(entry({ action: 'cowork.something_new' }), t)).toBe('You something new');
    });
});

describe('changedWords', () => {
    it('keeps a field it has no word for as its name', () => {
        expect(changedWords(['colour'], t)).toBe('colour');
    });

    it('says the spending limit, never the raw name "monthlyBudget", and has a word for every field the server audits', () => {
        expect(trailLine(entry({ changed: ['monthlyBudget'] }), t)).toBe('You changed the spending limit');
        // server/usecases/coworkAudit.mts AUDITED_FIELDS (its test holds the dictionary to the same list).
        const audited = ['isActive', 'repeatInterval', 'daysOfWeek', 'timeOfDay', 'timezone', 'modelTier', 'agentId', 'triggerKind', 'nextRunAt',
            'enabledApps', 'automationId', 'fingerprint', 'version', 'action', 'level', 'toUserId', 'monthlyBudget', 'kind', 'stepId', 'trusted',
            'title', 'prompt', 'trigger', 'answer', 'sentence', 'targetPercent', 'deskRole', 'shares'];
        for (const field of audited) expect(changedWords([field], t), field).not.toBe(field);
    });
});

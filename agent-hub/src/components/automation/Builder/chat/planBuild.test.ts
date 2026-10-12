import { describe, expect, it } from 'vitest';
import { followUpPlanId, inProgressPlanId, isPlanInProgress } from './planBuild';

describe('planBuild — which plan a message belongs to', () => {
    it('a plan is open while it builds or waits for an answer, and closed before approval and after the build', () => {
        expect(isPlanInProgress({ id: 'p1', status: 'building' })).toBe(true);
        expect(isPlanInProgress({ id: 'p1', status: 'paused' })).toBe(true);
        expect(isPlanInProgress({ id: 'p1', status: 'review' })).toBe(false);
        expect(isPlanInProgress({ id: 'p1', status: 'built' })).toBe(false);
        expect(isPlanInProgress(null)).toBe(false);
        expect(inProgressPlanId({ id: 'p1', status: 'paused' })).toBe('p1');
        expect(inProgressPlanId({ id: 'p1', status: 'built' })).toBeNull();
    });

    it('a follow-up during an open build continues it', () => {
        expect(followUpPlanId({ plan: { id: 'p1', status: 'building' } })).toBe('p1');
        expect(followUpPlanId({ plan: { id: 'p1', status: 'paused' } })).toBe('p1');
    });

    it('a message in plan mode (review, built, no plan) starts a plan turn, not a build', () => {
        expect(followUpPlanId({ plan: { id: 'p1', status: 'review' } })).toBeNull();
        expect(followUpPlanId({ plan: { id: 'p1', status: 'built' } })).toBeNull();
        expect(followUpPlanId({ plan: null })).toBeNull();
        // An answer to plain plan-mode questions has no planId either.
        expect(followUpPlanId({ plan: { id: 'p1', status: 'review' }, questionsPlanId: null, answering: true })).toBeNull();
    });

    it('an answer to a question the build asked continues that build even when the status lags', () => {
        expect(followUpPlanId({ plan: { id: 'p1', status: 'review' }, questionsPlanId: 'p1', answering: true })).toBe('p1');
        expect(followUpPlanId({ plan: { id: 'p1', status: 'review' }, questionsPlanId: 'p1', answering: false })).toBeNull();
        expect(followUpPlanId({ plan: { id: 'p2', status: 'review' }, questionsPlanId: 'p1', answering: true })).toBeNull();
        expect(followUpPlanId({ plan: { id: 'p1', status: 'built' }, questionsPlanId: 'p1', answering: true })).toBeNull();
    });
});

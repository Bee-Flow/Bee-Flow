import { describe, it, expect } from 'vitest';
import { resolveTourCompletionNavigation } from './tourCompletion';

describe('resolveTourCompletionNavigation (BFSF-472)', () => {
    it('first-time onboarding: intro tour that navigated lands back on Direct chat', () => {
        expect(resolveTourCompletionNavigation({ isIntro: true, navigated: true })).toBe('agents');
    });

    it('a tour started with a returnTo goes back there — even the intro lesson', () => {
        expect(resolveTourCompletionNavigation({ isIntro: true, navigated: true, returnTo: 'settings/learning' })).toBe('settings/learning');
    });

    it('returnTo wins even when the tour never navigated', () => {
        expect(resolveTourCompletionNavigation({ isIntro: false, navigated: false, returnTo: 'settings/learning' })).toBe('settings/learning');
    });

    it('an intro replay without return context stays on chat only when it navigated', () => {
        expect(resolveTourCompletionNavigation({ isIntro: true, navigated: false })).toBeNull();
    });

    it('any other lesson leaves the learner where the tour ended', () => {
        expect(resolveTourCompletionNavigation({ isIntro: false, navigated: true })).toBeNull();
        expect(resolveTourCompletionNavigation({ isIntro: false, navigated: false })).toBeNull();
    });

    it('an empty returnTo is no return context', () => {
        expect(resolveTourCompletionNavigation({ isIntro: true, navigated: true, returnTo: '' })).toBe('agents');
    });
});

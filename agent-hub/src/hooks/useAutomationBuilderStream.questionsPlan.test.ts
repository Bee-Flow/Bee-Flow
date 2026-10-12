import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';

/**
 * A question the build asked while an approved plan was running carries that
 * plan's id, so the answer continues the build. A reload must not lose it: the
 * server keeps it in the snapshot's questionsMeta.
 */
describe('useAutomationBuilderStream — which plan a question belongs to', () => {
    it('restores the plan id from questionsMeta, and not for questions that belong to no plan', () => {
        const { result } = renderHook(() => useAutomationBuilderStream({}));
        const questions = [{ id: 'q1', prompt: 'Which?', options: ['a', 'b'] }];
        act(() => result.current.hydrate({ reviewQuestions: questions, questionsMeta: { round: 1, planId: 'p1', mode: 'build' } }));
        expect(result.current.state.reviewQuestionsPlanId).toBe('p1');
        act(() => result.current.hydrate({ reviewQuestions: questions, questionsMeta: { round: 1, planId: null, mode: 'plan' } }));
        expect(result.current.state.reviewQuestionsPlanId).toBeNull();
        act(() => result.current.hydrate({ reviewQuestions: null, questionsMeta: { round: 1, planId: 'p1' } }));
        expect(result.current.state.reviewQuestions).toBeNull();
        expect(result.current.state.reviewQuestionsPlanId).toBeNull();
    });
});

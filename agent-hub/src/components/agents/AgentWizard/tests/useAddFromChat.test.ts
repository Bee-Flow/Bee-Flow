import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useAddFromChat from './useAddFromChat';
import { REFUSAL } from './testSetFacts';

const t = (_key: string, fallback?: string) => fallback ?? _key;
const DRAFT = {
    name: '', question: 'Q?', writtenBy: {},
    expect: { mustMention: [], mustNotMention: [], toolsExpected: [], rulesExpected: [], notes: '' },
};
const turn = { question: 'Q?', answer: 'A.', toolsUsed: ['search_kb'] };

function setup(over: Record<string, unknown> = {}) {
    const testSet = {
        suggest: vi.fn(async () => ({ suggestion: { expect: { mustMention: ['x'] }, wrote: { mustMention: 'ai' } }, refusal: null })),
        createTest: vi.fn(async () => ({ test: { id: 't1' }, refusal: null })),
        ...over,
    };
    const hook = renderHook(() => useAddFromChat({ t, testSet: testSet as any }));
    return { testSet, ...hook };
}

describe('useAddFromChat', () => {
    it('asks for a proposal for the turn and ends up ready with it', async () => {
        const { result, testSet } = setup();
        await act(async () => { await result.current.open(turn); });
        expect(testSet.suggest).toHaveBeenCalledWith(turn);
        expect(result.current.state).toBe('ready');
        expect(result.current.turn).toEqual(turn);
        expect(result.current.suggestion?.wrote?.mustMention).toBe('ai');
        expect(testSet.createTest).not.toHaveBeenCalled();
    });

    it('opens an empty form with the refusal when no proposal came', async () => {
        const refusal = { kind: REFUSAL.NO_SUGGESTER, code: 'no_suggester', status: 503, retryable: false, serverMessage: '' };
        const { result } = setup({ suggest: vi.fn(async () => ({ suggestion: null, refusal })) });
        await act(async () => { await result.current.open(turn); });
        expect(result.current.suggestion).toBeNull();
        expect(result.current.refusal).toBe(refusal);
    });

    it('creates the test on save and closes', async () => {
        const { result, testSet } = setup();
        await act(async () => { await result.current.open(turn); });
        await act(async () => { await result.current.save(DRAFT); });
        expect(testSet.createTest).toHaveBeenCalledWith(DRAFT);
        expect(result.current.turn).toBeNull();
    });

    it('keeps the form open with an error when saving fails', async () => {
        const refusal = { kind: REFUSAL.TOO_MANY, code: 'too_many_tests', status: 409, retryable: false, serverMessage: '' };
        const { result } = setup({ createTest: vi.fn(async () => ({ test: null, refusal })) });
        await act(async () => { await result.current.open(turn); });
        await act(async () => { await result.current.save(DRAFT); });
        expect(result.current.turn).toEqual(turn);
        expect(result.current.saving).toBe(false);
        expect(result.current.saveError).toMatch(/as many tests/);
    });

    it('does not reopen after cancel when the proposal arrives late', async () => {
        let release: (v: unknown) => void = () => {};
        const { result } = setup({ suggest: vi.fn(() => new Promise(r => { release = r; })) });
        let pending: Promise<void> = Promise.resolve();
        act(() => { pending = result.current.open(turn); });
        act(() => { result.current.close(); });
        await act(async () => { release({ suggestion: null, refusal: null }); await pending; });
        expect(result.current.turn).toBeNull();
        expect(result.current.state).toBe('loading');
    });
});

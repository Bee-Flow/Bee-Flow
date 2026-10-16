import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import useBuilderTabUrl from './useBuilderTabUrl';

describe('useBuilderTabUrl — openRunInRuns', () => {
    it('switches to Runs and reports the run in the URL state (pushed, not replaced)', () => {
        const onBuilderStateChange = vi.fn();
        const { result } = renderHook(() => useBuilderTabUrl({ initialTab: 'build', onBuilderStateChange }));
        act(() => result.current.openRunInRuns('run_9'));
        expect(result.current.tab).toBe('history');
        expect(onBuilderStateChange).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run_9', stepId: null, replace: false }));
    });
});

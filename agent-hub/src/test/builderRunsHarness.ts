// useBuilderRuns with every dependency injected as a fake, for the run-start,
// form-trigger, guard and Execute-confirm tests. No module mocks: the hook
// takes its api, run controls and confirm as options.
//
//   const h = renderBuilderRuns({ effectiveDef: DEF });
//   h.deps.api.dryRun.mockResolvedValue({ accepted: true, pending: true, runId: 'r1' });
//   await act(() => h.result.current.onDryRun());
import { renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import useBuilderRuns, { type UseBuilderRunsOptions } from '@/components/automation/Builder/useBuilderRuns';
import type { FlowDefinition } from '@/components/automation/Builder/flow/types';

/** A follow that never settles unless the test resolves it. */
function pendingFollow() {
    let settle: (value: unknown) => void = () => {};
    const fn = vi.fn(() => new Promise<never>((resolve) => { settle = resolve as (value: unknown) => void; }));
    return { fn, settle: (value: unknown) => settle(value) };
}

export function makeBuilderRunsDeps(effectiveDef: FlowDefinition | null) {
    const follow = pendingFollow();
    return {
        follow,
        deps: {
            api: { run: vi.fn(), dryRun: vi.fn(), formTest: vi.fn() },
            state: { dryRun: null, steps: [], executingStepId: null },
            effectiveDef,
            executeStep: vi.fn<UseBuilderRunsOptions['executeStep']>(async () => ({ kind: 'settled', run: { id: 'r', status: 'success' }, steps: [] })),
            followRun: follow.fn,
            continueRun: vi.fn(),
            setRunResult: vi.fn(),
            ensureAutomationCreated: vi.fn(async () => 'a1'),
            noteManagedRefusal: vi.fn(() => false),
            busy: false,
            setBusy: vi.fn(),
            setError: vi.fn(),
            confirm: vi.fn<UseBuilderRunsOptions['confirm']>(async () => true),
            setTab: vi.fn(),
        },
    };
}

export type BuilderRunsDeps = ReturnType<typeof makeBuilderRunsDeps>['deps'];

/** Render the hook; `rerender(patch)` re-renders with some options changed (a run's state, busy, ...). */
export function renderBuilderRuns(effectiveDef: FlowDefinition | null, over: Partial<UseBuilderRunsOptions> = {}) {
    const made = makeBuilderRunsDeps(effectiveDef);
    const props: UseBuilderRunsOptions = { ...made.deps, ...over };
    const hook = renderHook((p: UseBuilderRunsOptions) => useBuilderRuns(p), { initialProps: props });
    return {
        ...hook,
        deps: made.deps,
        settleFollow: made.follow.settle,
        rerender: (patch: Partial<UseBuilderRunsOptions>) => hook.rerender({ ...props, ...patch }),
    };
}

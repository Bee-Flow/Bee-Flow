import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAutomationPersistence, { makeBlockSkeleton } from './useAutomationPersistence';
import type { UseAutomationPersistenceOptions } from './useAutomationPersistence';
import { unwrapRow } from './unwrapRow';
import type { FlowDefinition } from './flow/types';

/**
 * The canvas's debounced save has to reach the server through the same route
 * as every other write of that row. A reusable Step lives behind /api/step,
 * which validates the definition as a Step (`scope: 'block'`) and keeps the
 * datatable and knowledge-base usage in step with it; /api/automation/:id does
 * neither for a Step. The inspector's save already went through /api/step; the
 * canvas (palette, drag, undo/redo) did not.
 */

const skeleton = makeBlockSkeleton() as unknown as FlowDefinition;
const edited = { ...makeBlockSkeleton(), steps: [{ id: 'set1', type: 'set', fields: {} }, { id: 'out', type: 'layer_output', fields: {} }] } as unknown as FlowDefinition;

function mount(isStep: boolean) {
    const updateAutomation = vi.fn(async (_id: string, body: unknown) => ({ automation: { id: 'row1', ...(body as object) } }));
    const updateStep = vi.fn(async (_id: string, body: unknown) => ({ step: { id: 'row1', ...(body as object) } }));
    const setServerAutomation = vi.fn();
    const options = {
        api: { updateAutomation, updateStep },
        isStep,
        apiCreateOne: vi.fn(),
        apiUpdateOne: isStep ? updateStep : updateAutomation,
        unwrapRow,
        state: { automationId: 'row1', draft: skeleton, lastServerDraft: skeleton, running: false },
        serverAutomation: { id: 'row1', definition: skeleton },
        setServerAutomation,
        hydrate: vi.fn(),
        setDraft: vi.fn(),
        markServerConfirmed: vi.fn(),
        setValidation: vi.fn(),
        noteManagedRefusal: () => false,
        readOnlyRef: { current: false },
        effectiveDef: skeleton,
        scopeKey: null,
        setScopeKey: vi.fn(),
        t: (_key: string, fallback?: string) => fallback || '',
    } as unknown as UseAutomationPersistenceOptions;
    const hook = renderHook(() => useAutomationPersistence(options));
    return { hook, updateAutomation, updateStep, setServerAutomation };
}

describe('useAutomationPersistence — the route a canvas edit is saved through', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('saves a canvas edit of a reusable Step through the Step route, and adopts the row it answers', async () => {
        const { hook, updateAutomation, updateStep, setServerAutomation } = mount(true);
        act(() => { hook.result.current.onVisualEditRoot(edited); });
        await act(async () => { await vi.advanceTimersByTimeAsync(600); });
        expect(updateStep).toHaveBeenCalledWith('row1', { definition: edited });
        expect(updateAutomation).not.toHaveBeenCalled();
        expect(setServerAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'row1', definition: edited }));
    });

    it('saves a canvas edit of an automation through the automation route', async () => {
        const { hook, updateAutomation, updateStep, setServerAutomation } = mount(false);
        act(() => { hook.result.current.onVisualEditRoot(edited); });
        await act(async () => { await vi.advanceTimersByTimeAsync(600); });
        expect(updateAutomation).toHaveBeenCalledWith('row1', { definition: edited });
        expect(updateStep).not.toHaveBeenCalled();
        expect(setServerAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'row1', definition: edited }));
    });
});

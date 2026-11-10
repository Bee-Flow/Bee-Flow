import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import useStepPatchSave from './useStepPatchSave';
import type { FlowDefinition, FlowStep } from '../flow/types';

const t = (_key: string | undefined, fallback?: unknown) => String(fallback ?? '');

const START: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'ai_step', label: 'Old name', prompt: 'p' }],
    edges: [{ from: 'trg', to: 's1' }],
};

/**
 * The shell's side of a step save: the draft takes the edit at once (so the
 * drawer re-renders on it), and the PUT answers later.
 */
function useHarness() {
    const [definition, setDefinition] = useState<FlowDefinition>(START);
    const [saves] = useState<Array<{ next: FlowDefinition; land: () => void }>>([]);
    const onSaveStep = (next: unknown) => {
        setDefinition(next as FlowDefinition);
        return new Promise<void>((resolve) => { saves.push({ next: next as FlowDefinition, land: resolve }); });
    };
    const step = (definition.steps || []).find(s => s.id === 's1') as FlowStep;
    const save = useStepPatchSave({ definition: definition as Record<string, unknown>, step, onSaveStep, t: t as never });
    return { save, saves, step };
}

describe('useStepPatchSave — a patch queued behind a save in flight', () => {
    it('lands on top of that save, not on the definition from before it', async () => {
        const { result } = renderHook(() => useHarness());

        // The autosave of a rename goes out…
        act(() => { void result.current.save.persistStepPatch({ label: 'New name' }); });
        expect(result.current.saves).toHaveLength(1);
        expect(result.current.step.label).toBe('New name');

        // …and while it is on its way the author switches the step off.
        act(() => { void result.current.save.persistStepPatch({ disabled: true }); });
        expect(result.current.saves).toHaveLength(1);

        // (The first call's promise also covers the queued save, so it is not awaited here.)
        await act(async () => { result.current.saves[0].land(); });
        await waitFor(() => expect(result.current.saves).toHaveLength(2));

        const saved = result.current.saves[1].next.steps?.[0] as FlowStep;
        expect(saved.disabled).toBe(true);
        // The rename the first save carried must still be there.
        expect(saved.label).toBe('New name');
        await act(async () => { result.current.saves[1].land(); });
    });

    it('keeps a waiting form patch when an action is queued after it, and the other way round', async () => {
        const { result } = renderHook(() => useHarness());
        act(() => { void result.current.save.persistStepPatch({ label: 'New name' }); });

        // Behind that save: the form's next autosave, then Switch off, then Pin.
        // The later ones used to REPLACE the waiting patch, so the prompt was
        // never saved while the form took it for saved.
        act(() => { void result.current.save.persistStepPatch({ prompt: 'new prompt' }); });
        act(() => { void result.current.save.persistStepPatch({ disabled: true }, 'action'); });
        act(() => { void result.current.save.persistStepPatch({ pinnedOutput: { a: 1 } }, 'action'); });
        expect(result.current.saves).toHaveLength(1);

        await act(async () => { result.current.saves[0].land(); });
        await waitFor(() => expect(result.current.saves).toHaveLength(2));
        expect(result.current.saves[1].next.steps?.[0]).toMatchObject({
            label: 'New name', prompt: 'new prompt', disabled: true, pinnedOutput: { a: 1 },
        });
        await act(async () => { result.current.saves[1].land(); });
    });

    it('lets the form\'s newer patch replace its waiting one: a field put back in between is not written', async () => {
        const { result } = renderHook(() => useHarness());
        act(() => { void result.current.save.persistStepPatch({ disabled: true }, 'action'); });

        // The form diffs its whole draft against the step on screen. First the
        // label and the prompt differ; then the label is typed back to what it
        // was, so the next patch no longer names it.
        act(() => { void result.current.save.persistStepPatch({ label: 'Typo', prompt: 'new prompt' }); });
        act(() => { void result.current.save.persistStepPatch({ prompt: 'new prompt' }); });

        await act(async () => { result.current.saves[0].land(); });
        await waitFor(() => expect(result.current.saves).toHaveLength(2));
        const saved = result.current.saves[1].next.steps?.[0] as FlowStep;
        expect(saved).toMatchObject({ label: 'Old name', prompt: 'new prompt', disabled: true });
        await act(async () => { result.current.saves[1].land(); });
    });
});

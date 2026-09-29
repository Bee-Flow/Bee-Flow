// The step drawer's coalesced save (the contract the old inspector used),
// moved out of NodeDetailView unchanged: one save in flight, the latest patch
// queued behind it, a failed patch kept for the chip's retry, and a queued
// patch flushed on unmount (close within the autosave debounce).
import { useCallback, useEffect, useRef, useState } from 'react';
import useSavingState from '../../../../hooks/useSavingState';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { normalizeDefinitionShape } from '../flow/normalizeDefinition';
import { mergeStepPatchIntoDefinition } from '../flow/switchCaseOps';
import type { FlowStep } from '../flow/types';

type Patch = Record<string, unknown>;
type Definition = Record<string, unknown> | null;
type SaveFn = ((next: unknown) => Promise<unknown> | unknown) | null;

const merge = mergeStepPatchIntoDefinition as (def: unknown, step: unknown, patch: unknown) => unknown;
const normalize = normalizeDefinitionShape as (def: unknown) => unknown;

export default function useStepPatchSave({ definition, step, onSaveStep, t }: {
    definition: Definition;
    step: FlowStep | null;
    onSaveStep: SaveFn;
    t: TranslateFn;
}) {
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    // The chip is the ONLY lasting signal that an auto-save landed (BFSF-338),
    // so it keeps a timestamp and its error state offers a retry.
    const { state: saveStatus, setSaving: markSaving, setSaved: markSaved, setError: markSaveError } = useSavingState();
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const failedPatchRef = useRef<Patch | null>(null);
    const saveInflightRef = useRef<Promise<void> | null>(null);
    const saveQueuedRef = useRef<Patch | null>(null);
    const definitionRef = useRef(definition);
    const stepRef = useRef(step);
    const onSaveStepRef = useRef(onSaveStep);
    useEffect(() => { definitionRef.current = definition; stepRef.current = step; onSaveStepRef.current = onSaveStep; });

    const persistStepPatch = useCallback(async (patch: Patch): Promise<void> => {
        if (!definition || typeof onSaveStep !== 'function' || !step) return undefined;
        if (saveInflightRef.current) { saveQueuedRef.current = patch; return saveInflightRef.current; }
        const doSave = async (currentPatch: Patch) => {
            // Normalize before patching: a trigger-only merge on a base that
            // lacks steps/edges would PUT a graph the server rejects (BFSF-318).
            const next = merge(normalize(definition) || definition, step, currentPatch);
            setSaving(true);
            setSaveError(null);
            markSaving();
            try {
                await onSaveStep(next);
                failedPatchRef.current = null;
                setLastSavedAt(new Date());
                markSaved();
            } catch (e) {
                const err = e as { message?: string };
                setSaveError(err?.message || t('routines.ndv.save_failed', 'Save failed'));
                failedPatchRef.current = currentPatch;
                markSaveError(e);
                // Re-thrown: SettingsForm.flushNow advances its baseline only
                // when this resolves, so a swallowed error lost the edit.
                throw e;
            } finally {
                setSaving(false);
            }
        };
        saveInflightRef.current = (async () => {
            try { await doSave(patch); } finally {
                const queued = saveQueuedRef.current;
                saveQueuedRef.current = null;
                saveInflightRef.current = null;
                if (queued) await persistStepPatch(queued);
            }
        })();
        return saveInflightRef.current;
    }, [definition, step, onSaveStep, markSaving, markSaved, markSaveError, t]);

    // "Save failed" comes with a way out; the chip already reports the outcome.
    const retrySave = useCallback(() => {
        const patch = failedPatchRef.current;
        if (!patch) return;
        persistStepPatch(patch)?.catch(() => {});
    }, [persistStepPatch]);

    useEffect(() => () => {
        const queued = saveQueuedRef.current;
        if (!queued) return;
        saveQueuedRef.current = null;
        const def = definitionRef.current, stp = stepRef.current, save = onSaveStepRef.current;
        if (!def || !stp || typeof save !== 'function') return;
        const next = merge(normalize(def) || def, stp, queued);
        Promise.resolve(save(next)).catch((err: { message?: string }) => console.warn('[NodeDetailView] flush on unmount failed:', err?.message || err));
    }, []);

    return { saving, saveError, saveStatus, lastSavedAt, persistStepPatch, retrySave };
}

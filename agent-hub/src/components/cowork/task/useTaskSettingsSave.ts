/**
 * Saving one row of a task's Settings (./CoworkTaskSettings.tsx), in the order the server needs it: the task itself
 * (that row's own fields: PUT /api/cowork/:id), then for When a start on an event (PUT /api/cowork/:id/start, which
 * makes a webhook's address), then what the save does to the steps (./coworkTaskSettingsModel.ts saveEffect): fixed
 * steps are taken off for the AI or an agent, or, for a change that needs them made again ("Save and test"), the
 * caller's plan maker makes and tests them. What comes back is a webhook's address, shown once.
 *
 * `useSettingRow` is what a row's form holds: its draft, its submit, and what its save bar says.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { canSave, changeOf, rowChanged, saveEffect, startChoiceOf, type DraftRowId, type SaveEffect, type TaskDraft } from './coworkTaskSettingsModel';
import { useCoworkItemActions } from '@/api/coworkTask';
import { useCoworkStart, type HookAddress } from '@/api/coworkStart';
import { useCoworkPlanActions } from '@/api/queries/coworkPlan';

function useTaskSettingsSave(itemId: string, initial: TaskDraft, onRebuild: () => void) {
    const { change } = useCoworkItemActions(itemId);
    const { choose } = useCoworkStart(itemId, false);
    const { remove } = useCoworkPlanActions(itemId);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const save = async (row: DraftRowId, draft: TaskDraft): Promise<{ ok: boolean; address: HookAddress | null }> => {
        setSaving(true);
        setError(null);
        try {
            const body = changeOf(row, draft);
            if (body) await change.mutateAsync(body);
            const start = row === 'when' ? startChoiceOf(draft, initial) : null;
            const answer = start ? await choose.mutateAsync(start) : null;
            const effect = saveEffect(draft, initial);
            if (effect === 'drops_steps') await remove.mutateAsync();
            if (effect === 'rebuild') onRebuild();
            return { ok: true, address: answer?.address ?? null };
        } catch (e) {
            setError(e);
            return { ok: false, address: null };
        } finally {
            setSaving(false);
        }
    };
    return { save, saving, error };
}

export interface SettingRowForm {
    itemId: string;
    /** The task as it is: what the row's draft starts from, and what a save is compared with. */
    initial: TaskDraft;
    /** Make the steps again from the sentence and test them once. */
    onRebuild: () => void;
    /** The row closes without a save (Cancel, or Done after a webhook's address was shown). */
    onDone: () => void;
    /** The row was saved: it closes, and says so. Without it, a save closes the row like onDone. */
    onSaved?: () => void;
    /** Something is on the go (a run, a test): nothing is saved now. */
    locked: boolean;
}

/** What the save bar of a row says (./taskRows.tsx SaveBar). */
export interface SaveState {
    /** What this save does to the steps: `rebuild` is "Save and test". */
    effect: SaveEffect;
    /** Something changed, and what the row needs is filled in. */
    ready: boolean;
    saving: boolean;
    locked: boolean;
    error: unknown;
}

/** One row's form: its draft, its submit, the webhook address a save made, and its save bar. */
export function useSettingRow(row: DraftRowId, { itemId, initial, onRebuild, onDone, onSaved = onDone, locked }: SettingRowForm) {
    const [draft, setDraft] = useState<TaskDraft>(initial);
    const [address, setAddress] = useState<HookAddress | null>(null);
    const { save, saving, error } = useTaskSettingsSave(itemId, initial, onRebuild);
    const set = (patch: Partial<TaskDraft>) => setDraft((d) => ({ ...d, ...patch }));
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const done = await save(row, draft);
        if (!done.ok) return;
        if (done.address) setAddress(done.address);
        else onSaved();
    };
    const bar: SaveState = { effect: saveEffect(draft, initial), ready: canSave(row, draft) && rowChanged(row, draft, initial), saving, locked, error };
    return { draft, set, submit, address, bar };
}

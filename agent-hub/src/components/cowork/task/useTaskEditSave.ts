/**
 * Saving the edit view of a task (./CoworkTaskEdit.tsx), in the order the server needs it: the task itself (name,
 * sentence, agent, the clock or the mail), then a start on an event (PUT /api/cowork/:id/start, which makes a
 * webhook's address), then how it works: fixed steps taken off for the AI or an agent, or made again from the sentence
 * and tried once ("Save and test", by the caller's plan maker). What comes back is a webhook's address, shown once.
 */
import { useState } from 'react';
import { changeOf, mustRebuild, startChoiceOf, type EditDraft } from './coworkTaskEditModel';
import { useCoworkItemActions } from '@/api/coworkTask';
import { useCoworkStart, type HookAddress } from '@/api/coworkStart';
import { useCoworkPlanActions } from '@/api/queries/coworkPlan';

export function useTaskEditSave(itemId: string, initial: EditDraft, onRebuild: () => void) {
    const { change } = useCoworkItemActions(itemId);
    const { choose } = useCoworkStart(itemId, false);
    const { remove } = useCoworkPlanActions(itemId);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const save = async (draft: EditDraft): Promise<{ ok: boolean; address: HookAddress | null }> => {
        setSaving(true);
        setError(null);
        try {
            await change.mutateAsync(changeOf(draft));
            const start = startChoiceOf(draft, initial);
            const answer = start ? await choose.mutateAsync(start) : null;
            if (initial.mode === 'steps' && draft.mode !== 'steps') await remove.mutateAsync();
            if (mustRebuild(draft, initial)) onRebuild();
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

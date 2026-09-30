/**
 * The configured n8n workflows as the admin edits them (N8nSection.jsx
 * `workflows` state): field edits and the enabled switches wait for Save,
 * while adding, removing and the knowledge-base switch store the whole list
 * at once — the web's persistWorkflows, which also carries any edit still
 * pending, exactly as there.
 */

import { useState } from 'react';

import { useSaveN8nWorkflows } from './n8nMutations';
import { workflowFrom } from '../model/n8n';
import type { DiscoveredWorkflow, N8nInput, N8nWorkflow } from '../model/n8nTypes';

export function useWorkflowDraft(saved: readonly N8nWorkflow[]) {
    const [draft, setDraft] = useState<N8nWorkflow[] | null>(null);
    const persist = useSaveN8nWorkflows();
    const list = draft ?? [...saved];

    const store = async (next: N8nWorkflow[]) => {
        setDraft(next);
        await persist.mutateAsync(next);
        setDraft(null);
    };
    const update = (id: string, patch: Partial<N8nWorkflow>) =>
        setDraft(list.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    const setInputs = (id: string, change: (inputs: N8nInput[]) => N8nInput[]) => {
        const target = list.find((w) => w.id === id);
        if (target) update(id, { inputs: change(target.inputs) });
    };

    return {
        list,
        dirty: draft !== null && JSON.stringify(draft) !== JSON.stringify(saved),
        saving: persist.isPending,
        error: persist.error,
        update,
        addInput: (id: string) => setInputs(id, (inputs) => [...inputs, { name: '', type: 'string', description: '', required: true }]),
        updateInput: (id: string, index: number, patch: Partial<N8nInput>) =>
            setInputs(id, (inputs) => inputs.map((input, i) => (i === index ? { ...input, ...patch } : input))),
        removeInput: (id: string, index: number) => setInputs(id, (inputs) => inputs.filter((_, i) => i !== index)),
        /** False when it is already configured (the web's "Workflow already added"). */
        add: async (found: DiscoveredWorkflow) => {
            if (list.some((w) => w.id === found.id)) return false;
            await store([...list, workflowFrom(found)]);
            return true;
        },
        remove: (id: string) => store(list.filter((w) => w.id !== id)),
        toggleKb: (id: string) => store(list.map((w) => (w.id === id ? { ...w, allowKbIngestion: !w.allowKbIngestion } : w))),
        save: () => store(list),
        discard: () => setDraft(null),
    };
}

export type WorkflowDraft = ReturnType<typeof useWorkflowDraft>;

/**
 * One step's form over the draft store — what the web's SettingsForm does
 * with its draft, baseline and autosave, on the phone's store.
 *
 * The form keeps its own DRAFT (the author's text exactly as typed, a row
 * added but not filled in yet) and writes every change straight through as
 * one store edit (stepForm `formWriteOp`): the store coalesces the undo
 * history and debounces the save, so the form needs no timer of its own. It
 * remembers what the step read as after its own write (the baseline), so the
 * echo of that write changes nothing on screen, while a change from elsewhere
 * — undo, the AI builder — is adopted, keeping a pending row the author just
 * added (formState `carryPendingRows`).
 *
 * Mount it under `key={stepId}`: paging to another step starts a new form.
 */

import { useState } from 'react';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { carryPendingRows, type FormDraft, type StepPatch } from '@/features/flow-editor/formState';
import { useDraftState } from '@/features/flow-editor/hooks';
import { findNode } from '@/features/flow-editor/model/outline';
import type { DraftStore } from '@/features/flow-editor/state';


import { formWriteOp, patchWriteOp, stepChanged } from './stepForm';
import { stepFormFor } from '../editors/registry';

export interface StepFormState {
    step: FlowNode | null;
    draft: FormDraft;
    set: (key: string, value: unknown) => void;
    setMany: (patch: FormDraft) => void;
    patchStep: (patch: StepPatch) => void;
}

export function useStepForm(store: DraftStore, stepId: string): StepFormState {
    const step = useDraftState(store, (s) => findNode(s.definition, stepId)) as FlowNode | null;
    const form = stepFormFor(step?.type);
    const [draft, setDraft] = useState<FormDraft>(() => (step ? form.extract(step) : {}));
    const [baseline, setBaseline] = useState<FormDraft>(draft);
    const [seen, setSeen] = useState(step);

    // A change from elsewhere replaces the draft (during render, so the old
    // values are never on screen for a frame).
    if (seen !== step) {
        setSeen(step);
        if (stepChanged(form, step, baseline)) {
            const incoming = step ? form.extract(step) : {};
            setBaseline(incoming);
            setDraft(carryPendingRows(incoming, draft));
        }
    }

    const commit = (next: FormDraft) => {
        setDraft(next);
        const written = store.getState().applyOp(formWriteOp(stepId, next, form));
        const now = written ? findNode(written, stepId) : null;
        if (now) setBaseline(stepFormFor(now.type).extract(now as FlowNode));
    };

    return {
        step,
        draft,
        set: (key, value) => commit({ ...draft, [key]: value }),
        setMany: (patch) => commit({ ...draft, ...patch }),
        patchStep: (patch) => {
            store.getState().applyOp(patchWriteOp(stepId, patch));
        },
    };
}

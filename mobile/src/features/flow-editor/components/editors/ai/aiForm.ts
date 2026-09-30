/**
 * The AI step's form pair: formState's, plus "Use my personal memory".
 *
 * The runner reads `step.useMemory === true` (execAi.js), the AI builder
 * writes it (stepEditing.js allows it on ai_step) and the web editor shows the
 * tick — but the web's formState neither extracts nor patches it, so a tick
 * there looks saved and saves nothing. The phone carries it both ways: on as
 * `true`, off as no key at all (the runner's default), and untouched when
 * the tick did not change, so opening a step never rewrites it.
 */

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState, type FormDraft, type StepPatch } from '@/features/flow-editor/formState';

import type { StepForm } from '../types';

export const AI_STEP_FORM: StepForm = {
    extract: (step: FlowNode): FormDraft => ({ ...extractFormState(step), useMemory: step.useMemory === true }),
    patch: (step: FlowNode, draft: FormDraft): StepPatch => {
        const patch = buildPatch(step, draft);
        const on = draft.useMemory === true;
        if (on !== (step.useMemory === true)) patch.useMemory = on ? true : undefined;
        return patch;
    },
};

/**
 * Test-only: a step editor mounted the way the node editor mounts it — the
 * registry picks the component, the step's form pair makes the draft, every
 * `set`/`setMany` replaces the draft — without the draft store. `patch()`
 * answers what the node editor would save for the draft on screen now.
 * Nothing in the app imports this.
 */

import { QueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import type { FormDraft, StepPatch } from '@/features/flow-editor/formState';
import type { FlowDefinition } from '@/features/flow-editor/model';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { renderStepEditor, stepFormFor } from './registry';
import type { StepEditorContext } from './types';

export interface EditorHarness {
    draft: () => FormDraft;
    patch: () => StepPatch;
    patchedStep: () => StepPatch[];
}

export async function renderEditor(step: FlowNode, ctx: Partial<StepEditorContext> = {}): Promise<EditorHarness> {
    const form = stepFormFor(step.type);
    let latest = form.extract(step);
    const raw: StepPatch[] = [];
    const definition = (ctx.definition ?? { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [step], edges: [] }) as FlowDefinition;
    const full: StepEditorContext = {
        flowKey: 'flow-1',
        definition,
        catalog: null as FlowCatalog | null,
        groups: [],
        sampleRoot: null,
        stepLabelById: null,
        errorSections: new Set(),
        mode: 'advanced',
        disabled: false,
        ...ctx,
    };
    function Host() {
        const [draft, setDraft] = useState<FormDraft>(latest);
        const commit = (next: FormDraft) => {
            latest = next;
            setDraft(next);
        };
        return renderStepEditor({
            step,
            draft,
            set: (key, value) => commit({ ...latest, [key]: value }),
            setMany: (patch) => commit({ ...latest, ...patch }),
            patchStep: (patch) => raw.push(patch),
            ctx: full,
        });
    }
    await renderWithProviders(
        <ConfirmProvider>
            <ToastProvider>
                <Host />
            </ToastProvider>
        </ConfirmProvider>,
        // A mutation's default 5-minute gc timer would keep Jest alive after the last test.
        { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } }) },
    );
    return { draft: () => latest, patch: () => form.patch(step, latest), patchedStep: () => raw };
}

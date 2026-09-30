/**
 * Test-only: a SpecContext around one step, and a scripted edit through a
 * spec — what the declarative editor does on screen, without the screen.
 * Nothing in the app imports this.
 */

import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import type { FormDraft, StepPatch } from '@/features/flow-editor/formState';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { fieldId, specDraft, specPatch, writeField } from './runtime';
import type { EditorSpec, FieldSpec, SpecContext } from './spec';

export function specContext(step: FlowNode, extra: Partial<SpecContext> = {}): SpecContext {
    const definition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [step], edges: [] } as unknown as FlowDefinition;
    return {
        flowKey: 'flow-1',
        definition,
        catalog: null as FlowCatalog | null,
        groups: [],
        sampleRoot: null,
        stepLabelById: null,
        errorSections: new Set(),
        mode: 'advanced',
        disabled: false,
        step,
        ...extra,
    };
}

export function findField(spec: EditorSpec, id: string): FieldSpec {
    for (const section of spec.sections) {
        const hit = section.fields.find((f) => fieldId(f) === id);
        if (hit) return hit;
    }
    throw new Error(`${spec.type} has no field "${id}"`);
}

/** Apply edits in order, as the author would, and return the draft and the patch they save. */
export function editThrough(
    spec: EditorSpec,
    step: FlowNode,
    edits: readonly (readonly [id: string, value: unknown])[],
    extra: Partial<SpecContext> = {},
): { draft: FormDraft; patch: StepPatch } {
    const ctx = specContext(step, extra);
    let draft = specDraft(spec, step);
    for (const [id, value] of edits) draft = writeField(findField(spec, id), value, draft, ctx);
    return { draft, patch: specPatch(spec, step, draft) };
}

/**
 * How an edit in the node editor becomes one draft-store edit — pure.
 *
 * The web's node editor keeps a form draft, builds `buildPatch(step, draft)`
 * (only what changed) and merges it with `mergeStepPatchIntoDefinition`, which
 * heals a switch's and a Condition's edges in the same definition when the
 * patch changes the step's shape. The phone does the same, per change, as a
 * DraftOp — so every change is one undo entry and one debounced save. One
 * addition: a Privacy Shield mode switch that leaves a connection with no
 * port (droppedEdgesOnModeChange — the change the editor asks about first)
 * takes that connection out in the same edit, so the confirmation is true.
 *
 * A step held in a loop's body or a parallel branch is opened by its address
 * (outline/nested.ts, `loop_1/b_set`). It has no edges to heal, so its patch
 * is merged where it sits — what the web's LoopBodyEditor does per body row.
 */

import { isPrivacyStep, type FlowNode } from '@/features/flow-editor/bindings';
import { deepEqual, type FormDraft, type StepPatch } from '@/features/flow-editor/formState';
import {
    mergeStepPatchIntoDefinition,
    removeEdgesByIdentity,
    type FlowDefinition,
} from '@/features/flow-editor/model';
import { findNode, isNestedAddress, updateAtAddress } from '@/features/flow-editor/model/outline';

import { droppedEdgesOnModeChange } from '../editors/declarative/specs/privacy';
import type { StepForm } from '../editors/types';

function modeOf(patch: StepPatch): unknown {
    const onFound = patch.onFound as { tokenize?: boolean } | undefined;
    if (patch.type === 'tokenize') return 'hide';
    if (patch.type === 'untokenize') return 'reveal';
    return onFound?.tokenize ? 'check_hide' : 'check';
}

/** A patch merged into its node, edges healed; the same object when nothing changes. */
export function writeStepPatch(definition: FlowDefinition, stepId: string, patch: StepPatch): FlowDefinition {
    const node = findNode(definition, stepId);
    if (!node || !Object.keys(patch).length) return definition;
    if (isNestedAddress(stepId)) return updateAtAddress(definition, stepId, (s) => ({ ...s, ...patch, id: s.id }));
    let next = mergeStepPatchIntoDefinition(definition, node, patch);
    if (isPrivacyStep(node as FlowNode) && patch.type && patch.type !== node.type) {
        const dropped = droppedEdgesOnModeChange(node as FlowNode, modeOf(patch), definition.edges || []);
        if (dropped.length) next = { ...next, edges: removeEdgesByIdentity(next.edges, dropped.map((d) => d.edge)) };
    }
    return next;
}

/** The DraftOp for "the form of `stepId` now holds `draft`". */
export function formWriteOp(stepId: string, draft: FormDraft, form: StepForm) {
    return (definition: FlowDefinition): FlowDefinition => {
        const node = findNode(definition, stepId);
        if (!node) return definition;
        return writeStepPatch(definition, stepId, form.patch(node as FlowNode, draft));
    };
}

/** The DraftOp for a raw patch (the JSON view, the pinned output). */
export function patchWriteOp(stepId: string, patch: StepPatch) {
    return (definition: FlowDefinition): FlowDefinition => writeStepPatch(definition, stepId, patch);
}

/** Has the step moved away from what the form last wrote or adopted? */
export function stepChanged(form: StepForm, step: FlowNode | null, baseline: FormDraft): boolean {
    return !deepEqual(step ? form.extract(step) : {}, baseline);
}

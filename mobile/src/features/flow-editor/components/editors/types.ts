/**
 * What a step editor is given — the contract between the node editor and
 * every per-type editor, declarative or bespoke (registry.ts).
 *
 * An editor edits the step's FORM DRAFT (formState's `extractFormState`),
 * never the step: `set` / `setMany` change the draft, and the node editor turns
 * each change into `buildPatch` → one draft-store edit, so a save, an undo
 * and the AI builder all see the same thing. `patchStep` is the way around
 * the draft for the rare edit the draft does not carry (a raw JSON view).
 */

import type { ComponentType } from 'react';

import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode, StepLabelMap, VariableGroup } from '@/features/flow-editor/bindings';
import type { FormDraft, StepPatch } from '@/features/flow-editor/formState';
import type { FlowDefinition } from '@/features/flow-editor/model';

/** How much of a form shows: Simple (the sections that make the step work) or all of it. */
export type FormMode = 'simple' | 'advanced';

export interface StepEditorContext {
    /** The automation id, or a new automation's draft key — what the flow-editor hooks take. */
    flowKey: string;
    /** The whole definition as the editor holds it. */
    definition: FlowDefinition;
    /** Where the step sits: its id, or a held step's address (outline/nested.ts, `loop_1/b_set`). */
    stepAddress?: string;
    /** The flowlet the step lives in (`definition` is then that flowlet's graph); null in the automation itself. */
    flowlet?: string | null;
    /** Null until it has loaded (and for good when it could not be). */
    catalog: FlowCatalog | null;
    /** The data the steps before this one produce (computeUpstreamGroups). */
    groups: readonly VariableGroup[];
    /** What paths resolve against for previews (buildSampleRoot over `groups`). */
    sampleRoot: unknown;
    stepLabelById: StepLabelMap;
    /** The sections holding a validation ERROR — forced open, never hidden. */
    errorSections: ReadonlySet<string>;
    /** The section the editor was opened AT (a finding's fix): opened first, never hidden. */
    focusSection?: string | null;
    mode: FormMode;
    /** Nothing can be changed (the AI builder is working on this automation). */
    disabled: boolean;
    /**
     * Rename a declared field's binding (`<base>.<from>` → `<base>.<to>`) across
     * the whole automation, in one edit, and answer how many bindings moved — the
     * web's `onRenameField`. Absent where the editor cannot see the automation.
     */
    renameField?: (base: string, from: string, to: string) => number | undefined;
}

export interface StepEditorProps {
    step: FlowNode;
    draft: FormDraft;
    set: (key: string, value: unknown) => void;
    setMany: (patch: FormDraft) => void;
    /** Merge a raw patch into the step, bypassing the draft. */
    patchStep: (patch: StepPatch) => void;
    ctx: StepEditorContext;
}

export type StepEditor = ComponentType<StepEditorProps>;

/** How a step becomes a draft and a draft a patch; formState's pair unless a type says otherwise. */
export interface StepForm {
    extract: (step: FlowNode) => FormDraft;
    patch: (step: FlowNode, draft: FormDraft) => StepPatch;
}

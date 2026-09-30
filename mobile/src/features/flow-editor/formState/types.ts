/**
 * The form draft and the step patch. Both are bags on purpose: the draft
 * holds whatever keys the step type's editor edits (see the per-family
 * extractors), and the patch holds only the keys that CHANGED — where an
 * `undefined` value means "remove this key" after the patch merge.
 */

import type { FlowNode } from '../bindings/types';

export type FormDraft = Record<string, unknown>;
export type StepPatch = Record<string, unknown>;
export type Step = FlowNode;

/** Step → the type-specific half of its draft (`label`/`icon` already in `base`). */
export type Extractor = (step: Step, base: FormDraft) => FormDraft;

/** Write the type-specific half of the patch, in place. */
export type Patcher = (patch: StepPatch, step: Step, draft: FormDraft) => void;

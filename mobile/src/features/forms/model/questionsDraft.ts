/**
 * The Questions tab edits ONE thing: the trigger's form. It holds a draft of
 * that declaration and saves it back into the automation's definition — the
 * whole definition, through the flow editor's draft store and its PUT, so
 * there is one validation pipeline, one version history, and the answers
 * table follows on that same save (the web's useFormDetail).
 */

import type { FlowDefinition, FormDeclaration } from '@/features/flow-editor';

/** The trigger's form of a definition, or null when the automation does not start with a form. */
export function triggerFormOf(definition: FlowDefinition | null | undefined): FormDeclaration | null {
    const trigger = definition?.trigger as { kind?: unknown; form?: unknown } | null | undefined;
    if (!trigger || trigger.kind !== 'form') return null;
    const form = trigger.form;
    return form && typeof form === 'object' && !Array.isArray(form) ? (form as FormDeclaration) : null;
}

/** The definition with its trigger's form replaced — everything else untouched. */
export function withTriggerForm(definition: FlowDefinition, form: FormDeclaration): FlowDefinition {
    const trigger = definition.trigger ?? { id: 'trg', type: 'trigger', kind: 'form' };
    return { ...definition, trigger: { ...trigger, form } };
}

/** A deep copy the draft can be edited through without touching what was saved. */
export function cloneForm(form: FormDeclaration): FormDeclaration {
    return JSON.parse(JSON.stringify(form)) as FormDeclaration;
}

/** Same declaration by value — what "unsaved changes" means. */
export function sameForm(a: FormDeclaration | null | undefined, b: FormDeclaration | null | undefined): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

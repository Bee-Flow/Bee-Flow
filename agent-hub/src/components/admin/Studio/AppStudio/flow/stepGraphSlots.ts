/**
 * The scopes of a CONTAINER kind of the step registry (while, try), for the
 * flow codec (./stepGraph): read from the child slots the server declares for
 * the kind (stepFlow.childSlotSpecs), one scope per slot, keyed by the slot's
 * field (`steps`, `catch`, `finally`), and one per entry of a list slot
 * (`<field>:<index>`). So a container added to the registry is drawn like a
 * loop without an edit to the codec; only its branch labels are listed here.
 *
 * An optional slot the step does not carry stays absent until a step is
 * dropped into its branch: absent and empty can mean different things (a try
 * without `catch` lets the failure through, an empty `catch` swallows it), and
 * opening an action on the canvas must not change it.
 *
 * The phone runs ./stepGraph in its lockstep test, so this file keeps to
 * relative and `@shared` imports.
 */
import { childSlotSpecs, isExtensionStepKind } from '@shared/appDefinition/stepFlow.mjs';

export { isExtensionStepKind };

/** The scope key of a try's `catch`: like an "If it fails" branch, its steps read the failure as error.*. */
export const CATCH_SCOPE = 'catch';

type Step = { kind: string; [key: string]: unknown };
type Label = (key: string, en: string) => string;

/** What a child slot is called on the canvas, by `<kind>.<field>`: [key, English]. A slot without an entry reads as its field name. */
const SLOT_LABELS: Record<string, [string, string]> = {
    'while.steps': ['studio_apps_flow_control.scope.while_steps', 'While it holds'],
    'try.steps': ['studio_apps_flow_control.scope.try_steps', 'Try'],
    'try.catch': ['studio_apps_flow_control.scope.try_catch', 'If a step fails'],
    'try.finally': ['studio_apps_flow_control.scope.try_finally', 'Always, at the end'],
};

function slotLabel(kind: string, field: string, label: Label): string {
    const entry = Object.prototype.hasOwnProperty.call(SLOT_LABELS, `${kind}.${field}`) ? SLOT_LABELS[`${kind}.${field}`] : null;
    return entry ? label(entry[0], entry[1]) : field;
}

/** The scopes of a registry container, in the order its steps are numbered. */
export function extensionScopesOf<S extends Step>(step: S, label: Label): Array<{ key: string; label: string; steps: S[] | undefined }> {
    return childSlotSpecs(step.kind).flatMap((slot) => {
        const text = slotLabel(step.kind, slot.field, label);
        const held = step[slot.field];
        const each = slot.each;
        if (each === undefined) return [{ key: slot.field, label: text, steps: held as S[] | undefined }];
        return (Array.isArray(held) ? held : []).map((entry: Record<string, unknown> | null, i: number) => ({
            key: `${slot.field}:${i}`, label: `${text} ${i + 1}`, steps: entry?.[each] as S[] | undefined,
        }));
    });
}

/** Writes a scope's steps back onto a registry container. An absent slot stays absent while its branch is empty. */
export function withExtensionScope<S extends Step>(step: S, key: string, steps: S[]): S {
    for (const slot of childSlotSpecs(step.kind)) {
        const each = slot.each;
        if (each === undefined) {
            if (key !== slot.field) continue;
            return !steps.length && step[slot.field] === undefined ? step : { ...step, [slot.field]: steps };
        }
        if (!key.startsWith(`${slot.field}:`)) continue;
        const at = Number(key.slice(slot.field.length + 1));
        const held = step[slot.field];
        const entries = (Array.isArray(held) ? held : []).map((entry: Record<string, unknown> | null, i: number) => (i === at ? { ...entry, [each]: steps } : entry));
        return { ...step, [slot.field]: entries };
    }
    return step;
}

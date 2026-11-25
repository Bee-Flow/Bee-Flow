import type { Definition } from './planTypes.mts';
import { stepsOf } from './planWalk.mts';

/** Owner-entered literal filters and destinations. Expressions and credentials stay out of the form. */
const INPUTS = ['query', 'folder', 'path', 'subject', 'to'] as const;
export interface PlanParameter { stepId: string; field: string; value: string }
export interface ParameterEdit extends PlanParameter { before: string }

function literals(definition: Definition) {
    const parameters = [];
    for (const { id, step } of stepsOf(definition)) {
        if (step.type !== 'integration_action' || !step.inputs || typeof step.inputs !== 'object') continue;
        for (const field of INPUTS) {
            const input = (step.inputs as Record<string, { kind?: string; value?: unknown } | null>)[field];
            if (input?.kind === 'literal' && typeof input.value === 'string' && input.value.length <= 2000 && !input.value.includes('{{')) {
                parameters.push({ stepId: id, field, input, value: input.value });
            }
        }
    }
    return parameters;
}

export function parametersOf(definition: Definition): PlanParameter[] {
    return literals(definition).map(({ stepId, field, value }) => ({ stepId, field, value }));
}

/** Match on the approved value as well as the field so a stale form cannot overwrite another edit. */
export function changeParameter(approved: Definition, edit: ParameterEdit): Definition | null {
    const copy = structuredClone(approved);
    const target = literals(copy).find((p) => p.stepId === edit.stepId && p.field === edit.field && p.value === edit.before);
    if (!target || !edit.value.trim() || edit.value.includes('{{')) return null;
    target.input.value = edit.value;
    return copy;
}

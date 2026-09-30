/**
 * The names a step editor's pills use — the same the cards use (outline
 * cardLabelMap): every step's label, a step inside a loop body or a branch
 * included, and an unlabelled step by what its card calls it, never its id;
 * plus any other step whose data the picker offers here. The web's
 * buildStepLabelMap knows the top level only, so a reference to the step just
 * above in a loop read "Previous step" in the muted style of a DELETED step.
 */

import { translate } from '@/core/i18n';
import type { VariableGroup } from '@/features/flow-editor/bindings';
import { cardLabelMap } from '@/features/flow-editor/components/outline/stepLabels';
import type { FlowDefinition } from '@/features/flow-editor/model';

const STEP_BASE = /^steps\.([^.[]+)\.output$/;

export function stepLabelsInScope(definition: FlowDefinition | null | undefined, groups: readonly VariableGroup[]): Map<string, string> {
    const labels = cardLabelMap(definition, translate);
    for (const group of groups) {
        const id = STEP_BASE.exec(group.basePath)?.[1];
        if (id && !labels.has(id) && group.label) labels.set(id, group.label);
    }
    return labels;
}

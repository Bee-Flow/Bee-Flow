import { defaultActionForKind } from './actionKindCatalog';
import { setAction } from '../state/definitionOps';
import type { AppAction, AppDefinition, FormFieldRef } from './appDefinition';

const applyAction = setAction as (
    def: AppDefinition,
    actionIdOrNull: string | null,
    action: AppAction,
) => { def: AppDefinition; actionId: string | null };

const fresh = defaultActionForKind as (
    kind: string,
    definition: AppDefinition | null | undefined,
    formFields?: FormFieldRef[],
) => AppAction;

/**
 * Add a fresh action of any kind to the definition, nothing pointing at it yet.
 *
 * This is the one creation path outside an event slot (the Logic tab, the data grid's action pickers): the
 * same defaults the event slot uses when the kind is switched, so a new action is exactly what the slot
 * would have made, and never a shape the spec does not know.
 */
export function addActionOfKind(
    definition: AppDefinition,
    kind: string,
    formFields: FormFieldRef[] = [],
): { def: AppDefinition; actionId: string | null } {
    return applyAction(definition, null, fresh(kind, definition, formFields));
}

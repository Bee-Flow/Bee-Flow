import { createContext, useContext } from 'react';

/**
 * How the RUN writes a list or a record into a `{{…}}` placeholder of the
 * step being edited (server/automation/bind.js interpolateTemplate `listAs`):
 *
 *   'text' — prose slots (the default): "red, green, blue", "name: Ann, …"
 *   'json' — slots that carry DATA: a tool's arguments, an AI step's inputs,
 *            a code step's inputs, a table row, an HTTP request, the source of
 *            a data extraction. The runner resolves those with listAs 'json'.
 *
 * SettingsForm provides it per step type, so every value editor below it
 * (BindingField, ValueBuilder) previews exactly what the step receives,
 * without each step editor threading a prop through.
 */
export type SlotListAs = 'text' | 'json';

const DATA_SLOT_STEP_TYPES = new Set([
    'integration_action', 'ai_step', 'code', 'datatable', 'http_request', 'data_extraction',
]);

/** The listAs the runner uses for a step type's bound inputs. */
export function listAsForStepType(type: unknown): SlotListAs {
    return typeof type === 'string' && DATA_SLOT_STEP_TYPES.has(type) ? 'json' : 'text';
}

export const SlotListAsContext = createContext<SlotListAs>('text');

/** The listAs of the step whose form this editor sits in ('text' outside one). */
export function useSlotListAs(): SlotListAs {
    return useContext(SlotListAsContext);
}

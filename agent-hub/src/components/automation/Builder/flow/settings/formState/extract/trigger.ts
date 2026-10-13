/** extractFormState for the trigger: its kind and the fields each kind edits. */
import { schemaToParams } from '../../../triggerSchemaUtils';
import type { TypeExtractor } from '../types';

export const triggerExtractors: Record<string, TypeExtractor> = {
    trigger: (step, base) => {
        const kind = step.kind || 'manual';
        return {
            ...base,
            kind,
            scheduleCron: step.schedule?.cron || '',
            scheduleTz:   step.schedule?.tz || 'Europe/Amsterdam',
            // Empty defaults: a fresh app_event trigger has no provider until
            // AppEventFields auto-snaps to the first AVAILABLE one (dynamic,
            // catalog-driven — a hardcoded 'gmail' could be unavailable).
            appProvider:  step.appEvent?.provider || '',
            appEventName: step.appEvent?.event || '',
            filter:       step.appEvent?.filter || {},
            // Hosted form (kind === 'form'). Kept as ONE object so the editor
            // can patch title/fields/theme without five parallel draft keys.
            form:         step.form && typeof step.form === 'object' ? step.form : null,
            // Agent trigger (kind === 'agent_call').
            toolName:     step.toolName || '',
            description:  step.description || '',
            // params is shared between layer_input (declared inline) and
            // agent_call (derived from the persisted JSON Schema).
            params:       kind === 'agent_call'
                ? schemaToParams(step.parametersSchema)
                : (Array.isArray(step.params) ? step.params : []),
        };
    },
};

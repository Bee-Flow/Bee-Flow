// The definition the useBuilderRuns tests run against: a form trigger as the
// primary, a second form trigger and a webhook trigger with a saved sample as
// additional entry points, and one step that sends mail.
import type { FlowDefinition } from '@/components/automation/Builder/flow/types';

export const PRIMARY_FORM = { title: 'Intake', fields: [{ name: 'naam', type: 'text', label: 'Naam' }] };
export const SECOND_FORM = { title: 'Follow-up', fields: [{ name: 'reden', type: 'text', label: 'Reden' }] };
export const HOOK_SAMPLE = { orderId: 7 };

/** `primaryPin` gives the primary form trigger a saved sample (a filled-in form). */
export function runDefinition(primaryPin?: Record<string, unknown>): FlowDefinition {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'form', label: 'Intake form', form: PRIMARY_FORM, ...(primaryPin ? { pinnedOutput: primaryPin } : {}) },
        triggers: [
            { id: 'trg2', type: 'trigger', kind: 'form', label: 'Follow-up form', form: SECOND_FORM },
            { id: 'hook', type: 'trigger', kind: 'webhook', label: 'Order hook', pinnedOutput: HOOK_SAMPLE },
        ],
        steps: [{ id: 's1', type: 'action', label: 'Mail the customer', tool: 'gmail_send' }],
        edges: [{ from: 'trg', to: 's1' }],
    } as FlowDefinition;
}

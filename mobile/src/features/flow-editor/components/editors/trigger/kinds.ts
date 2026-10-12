/**
 * The trigger's kind — the web's "Trigger kind" select (agent-hub
 * `Builder/flow/settings/triggerEditors.jsx` TriggerFields), pure:
 * which kinds a trigger node may be, what switching kind does to its name,
 * and what the kind's own settings band is called.
 *
 * A SECONDARY trigger (definition.triggers[]) may only be a webhook, an app
 * event or a schedule (palette CAN_BE_SECONDARY, the validator's
 * SECONDARY_TRIGGER_KINDS); a legacy kind the list no longer offers stays
 * visible and disabled — opening the editor must never change routing.
 * Pinned by trigger.lockstep.test.ts.
 */

import type { FormDraft } from '@/features/flow-editor/formState';
import { CAN_BE_SECONDARY, defaultTriggerLabel, isGeneratedTriggerLabel, type FlowDefinition } from '@/features/flow-editor/model';

import { msg, type Msg, type OptionSpec } from '../declarative/spec';

interface KindRow {
    value: string;
    label: Msg;
    /** Only the primary trigger may be this kind. */
    primaryOnly: boolean;
}

export const TRIGGER_KINDS: readonly KindRow[] = [
    { value: 'manual', label: msg('automations.trigger_editors.manual_runs_only_when_you_click', 'Manual — runs only when you click Run'), primaryOnly: true },
    { value: 'form', label: msg('automations.trigger_editors.form_a_public_page_people_fill', 'Form — a public page people fill in'), primaryOnly: true },
    { value: 'schedule', label: msg('automations.trigger_editors.schedule_runs_on_a_timer', 'Schedule — runs on a timer'), primaryOnly: false },
    { value: 'webhook', label: msg('automations.trigger_editors.webhook_inbound_https_post', 'Webhook — inbound HTTPS POST'), primaryOnly: false },
    { value: 'app_event', label: msg('automations.trigger_editors.app_event_e_g_new_gmail', 'App event — e.g. new Gmail email'), primaryOnly: false },
    { value: 'agent_call', label: msg('automations.trigger_editors.agent_callable_from_chat', 'Agent — callable from chat'), primaryOnly: true },
    { value: 'app_trigger', label: msg('automations.trigger_editors.studio_app_called_by_an_app', 'Studio App — called by an app action'), primaryOnly: true },
];

/** The kinds this node may be switched to; a stored kind it may not be stays, disabled. */
export function kindOptions(secondary: boolean, current: string): OptionSpec[] {
    const rows: OptionSpec[] = TRIGGER_KINDS.filter((k) => !secondary || !k.primaryOnly).map((k) => ({ value: k.value, label: k.label }));
    if (secondary && !CAN_BE_SECONDARY.has(current)) {
        rows.push({ value: current, label: msg('mobile.flow.trigger.kind_unsupported', '(unsupported here) {kind}', { kind: current }), disabled: true });
    }
    return rows;
}

/**
 * The draft after a kind switch: the node is renamed with it unless someone
 * named it by hand — without this the node kept reading "Manual" after a
 * switch to Schedule (BFSF-339).
 */
export function chooseKind(draft: FormDraft, next: string): FormDraft {
    return isGeneratedTriggerLabel(draft.label) ? { kind: next, label: defaultTriggerLabel(next) } : { kind: next };
}

/** The kinds with a settings band of their own. */
const KIND_FORMS = new Set(['agent_call', 'schedule', 'app_event', 'app_trigger', 'webhook', 'form']);

export function hasKindForm(kind: string): boolean {
    return KIND_FORMS.has(kind);
}

/** The band's name: the web's `kindTitle`. */
export function kindTitle(kind: string): Msg {
    switch (kind) {
        case 'agent_call':
            return msg('mobile.flow.trigger.title_agent_tool', 'Agent tool');
        case 'schedule':
            return msg('mobile.flow.trigger.title_schedule', 'Schedule');
        case 'app_trigger':
            return msg('automations.trigger_editors.app_inputs', 'App inputs');
        case 'webhook':
            return msg('mobile.flow.trigger.title_endpoint', 'Endpoint');
        case 'form':
            return msg('mobile.flow.trigger.title_form', 'Form');
        default:
            return msg('automations.trigger_editors.event', 'Event');
    }
}

/** Is this node one of the automation's ADDITIONAL triggers (definition.triggers[])? */
export function isSecondaryTrigger(definition: Pick<FlowDefinition, 'trigger' | 'triggers'> | null | undefined, stepId: unknown): boolean {
    if (!definition || !stepId || definition.trigger?.id === stepId) return false;
    return (definition.triggers || []).some((t) => t?.id === stepId);
}

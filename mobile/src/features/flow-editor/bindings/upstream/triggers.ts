/**
 * The groups a TRIGGER contributes: its payload (`trigger.output.*`) and the
 * one "Trigger info" group (`trigger.kind`, `trigger.event`, …) for the whole
 * graph. Port of agent-hub `Builder/mapping/upstream/triggers.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';
import { appendKey } from '@/shared/expr';

import { schemaToParams } from '../flowDeps/triggerSchemaUtils';
import type { Catalog, FlowDefinition, FlowNode, TriggerOutputEntry, VariableGroup } from '../types';
import { walkRelativePath } from '../walkPath';
import { fieldFor } from './fieldTree';
import { answerSample, namedFormFields } from './formAnswers';
import { samplePlaceholderFor } from './sampleFields';

/**
 * The non-payload facts a run knows about its trigger, in the shape of
 * runState.trigger (minus `output`), from the primary trigger.
 */
export function triggerMetaSample(definition: FlowDefinition | null | undefined): Record<string, unknown> {
    const tr: Partial<FlowNode> = definition?.trigger || {};
    const kind = tr.kind || 'manual';
    const schedule = tr.schedule;
    return {
        id: tr.id || 'trg',
        kind,
        source: kind,
        label: typeof tr.label === 'string' ? tr.label : null,
        provider: tr.appEvent?.provider || null,
        event: tr.appEvent?.event || null,
        firedAt: new Date().toISOString(),
        schedule: schedule ? { cron: schedule.cron || null, tz: schedule.tz || null, scheduledFor: null } : null,
    };
}

/** "Trigger info", as declared by the catalog's `triggerMeta`; null without it. */
export function describeTriggerMeta(definition: FlowDefinition | null | undefined, catalog: Catalog | null | undefined): VariableGroup | null {
    const fields = Array.isArray(catalog?.triggerMeta) ? catalog.triggerMeta : null;
    if (!fields || fields.length === 0) return null;
    const sample = triggerMetaSample(definition);
    const extra = Array.isArray(definition?.triggers) ? definition.triggers : [];
    const kinds = new Set<string>([definition?.trigger?.kind || 'manual', ...extra.map((x) => x?.kind || 'manual')]);
    const shown = fields.filter((f) => metaFieldApplies(f.key, kinds, definition, extra));
    if (shown.length === 0) return null;
    return {
        id: '__trigger_meta',
        label: t('mobile.flow.group.trigger_info', 'Trigger info'),
        kind: 'trigger_meta',
        basePath: 'trigger',
        sample,
        // Only fields the actual trigger produces, with ITS values: the
        // catalog's samples come from another trigger kind ("New mail").
        fields: shown.map((f) => ({
            key: f.key,
            path: f.path || `trigger.${f.key}`,
            sample: walkRelativePath(f.key, sample) ?? null,
        })),
    };
}

/** The web's metaFieldApplies: which trigger-info fields exist for these trigger kinds. */
function metaFieldApplies(key: string, kinds: Set<string>, definition: FlowDefinition | null | undefined, extra: FlowNode[]): boolean {
    switch (key) {
        case 'label': return typeof definition?.trigger?.label === 'string' && definition.trigger.label !== '';
        case 'provider':
        case 'event': return kinds.has('app_event');
        case 'schedule.cron': return kinds.has('schedule');
        case 'schedule.scheduledFor': return extra.some((x) => x?.kind === 'schedule');
        default: return true;
    }
}

/** Declared-params triggers (a flowlet's inputs, a Studio App's inputs). */
function describeParamsTrigger(trigger: FlowNode, kind: string): VariableGroup {
    const params = Array.isArray(trigger.params) ? trigger.params : [];
    const label = kind === 'app_trigger'
        ? t('mobile.flow.group.studio_app_inputs', 'Studio App inputs')
        : t('mobile.flow.group.flowlet_input', 'Flowlet input');
    return {
        id: trigger.id,
        label,
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: Object.fromEntries(params.map((p) => [p.name, samplePlaceholderFor(p.type)])),
        fields: params.map((p) => fieldFor(p.name, appendKey('trigger.output', p.name), samplePlaceholderFor(p.type))),
    };
}

/**
 * An agent tool's arguments ARE its declared parameters (trigger.
 * parametersSchema): the agent passes them as trigger.output.<name>.
 */
function describeAgentCallTrigger(trigger: FlowNode): VariableGroup {
    const params = schemaToParams(trigger.parametersSchema);
    return {
        id: trigger.id,
        label: t('mobile.flow.group.agent_inputs', 'Agent inputs'),
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: Object.fromEntries(params.map((p) => [p.name, samplePlaceholderFor(p.type)])),
        fields: params.map((p) => fieldFor(p.name, appendKey('trigger.output', p.name), samplePlaceholderFor(p.type))),
    };
}

/** A hosted form's answers ARE its declared fields — bindable before any submission. */
function describeFormTrigger(trigger: FlowNode): VariableGroup {
    const fields = namedFormFields(trigger.form);
    return {
        id: trigger.id,
        label: t('mobile.flow.group.form_answers', 'Form answers'),
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: Object.fromEntries(fields.map((f) => [f.name, answerSample(f)])),
        fields: fields.map((f) => fieldFor(f.name as string, appendKey('trigger.output', f.name as string), answerSample(f))),
    };
}

function triggerLabel(tr: FlowNode): string {
    const k = tr.kind || 'manual';
    if (k === 'manual') return t('mobile.flow.group.trigger_manual', 'Trigger (manual)');
    if (k === 'schedule') return t('mobile.flow.group.trigger_schedule', 'Trigger (schedule)');
    if (k === 'webhook') return t('mobile.flow.group.trigger_webhook', 'Trigger (webhook)');
    if (k === 'form') return t('mobile.flow.group.trigger_form', 'Trigger (form)');
    if (k === 'layer_input') return t('mobile.flow.group.flowlet_input', 'Flowlet input');
    if (k === 'app_trigger') return t('mobile.flow.group.trigger_studio_app', 'Trigger (Studio App)');
    if (k === 'agent_call') return t('mobile.flow.group.trigger_agent_call', 'Trigger (agent call)');
    if (k === 'app_event' && tr.appEvent) {
        const { provider, event } = tr.appEvent;
        return t('mobile.flow.group.trigger_app_event', 'Trigger ({provider} · {event})', {
            provider: String(provider),
            event: String(event),
        });
    }
    return nodeDefaultLabel('trigger', t);
}

function ownEntry(outputs: Record<string, TriggerOutputEntry>, key: string): TriggerOutputEntry | undefined {
    return Object.prototype.hasOwnProperty.call(outputs, key) ? outputs[key] : undefined;
}

export function describeTrigger(trigger: FlowNode, triggerOutputs: Record<string, TriggerOutputEntry>): VariableGroup {
    const kind = trigger.kind || 'manual';
    if (kind === 'layer_input' || kind === 'app_trigger') return describeParamsTrigger(trigger, kind);
    if (kind === 'form') return describeFormTrigger(trigger);
    if (kind === 'agent_call') return describeAgentCallTrigger(trigger);
    const key = kind === 'app_event' && trigger.appEvent ? `${trigger.appEvent.provider}.${trigger.appEvent.event}` : `__${kind}`;
    const entry = ownEntry(triggerOutputs, key) || ownEntry(triggerOutputs, '__manual') || { fields: [], sample: {} };
    return {
        id: trigger.id,
        label: triggerLabel(trigger),
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: entry.sample || {},
        // The catalog's sample is a real event's shape: `organizer.email` and
        // `attendees[*].email` are offered before the trigger has fired.
        fields: (entry.fields || []).map((f) => fieldFor(f.key, appendKey('trigger.output', f.key), f.sample)),
    };
}

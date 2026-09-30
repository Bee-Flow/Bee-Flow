/**
 * A trigger card's name and summary line — TriggerNode.jsx's per-kind `sub`,
 * with its chips read as words: a schedule's cadence and zone, an app event's
 * name, the tool an agent calls and its parameters, a form's questions.
 */

import {
    APP_EVENT_TYPE_LABEL, defaultTriggerLabel, describeCron, humanizeFieldKey,
    type AnyNode, type Summary, type Translate,
} from '..';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Param {
    name?: string;
    required?: boolean;
}

/** "New email (Gmail)", or the event's own id in words when the table has never heard of it. */
export function appEventText(appEvent: { provider?: string; event?: string } | null | undefined): string {
    const provider = appEvent?.provider || '';
    const event = appEvent?.event || '';
    const key = `${provider}.${event}`;
    const curated = Object.prototype.hasOwnProperty.call(APP_EVENT_TYPE_LABEL, key) ? APP_EVENT_TYPE_LABEL[key] : undefined;
    if (curated) return curated;
    const eventWords = humanizeFieldKey(event);
    const providerWords = humanizeFieldKey(provider);
    if (eventWords && providerWords) return `${eventWords} (${providerWords})`;
    return eventWords || providerWords || key;
}

function paramWords(params: Param[], max: number): string[] {
    const words = params.slice(0, max).map((p) => `${p.name}${p.required ? '*' : ''}`);
    return params.length > max ? [...words, `+${params.length - max}`] : words;
}

function agentCallSummary(node: AnyNode): Summary {
    const toolName = str(node.toolName) || `automation_${node.id}`;
    const schema = (node.parametersSchema as { properties?: object; required?: unknown } | undefined) ?? {};
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const params = Object.keys(schema.properties || {}).map((name) => ({ name, required: required.has(name) }));
    return [truncate(toolName, 22), ...paramWords(params, 3)].join(' · ');
}

function inputsSummary(node: AnyNode, t: Translate): Summary {
    const params = (Array.isArray(node.params) ? (node.params as Param[]) : []).filter((p) => p && p.name);
    if (node.kind === 'app_trigger') {
        return [...paramWords(params, 3), t('routines.trigger.viewer_chip', 'Signed-in user')].join(' · ');
    }
    return params.length ? paramWords(params, 4).join(' · ') : { muted: 'no inputs' };
}

function formSummary(node: AnyNode): Summary {
    const form = (node.form as { title?: string; fields?: unknown[] } | null | undefined) ?? {};
    const n = Array.isArray(form.fields) ? form.fields.length : 0;
    if (!n) return { muted: 'no questions yet' };
    return `${form.title ? `${form.title} · ` : ''}${n} question${n === 1 ? '' : 's'}`;
}

function scheduleSummary(node: AnyNode): Summary {
    const schedule = (node.schedule as { cron?: string; tz?: string } | null | undefined) ?? {};
    if (!schedule.cron) return { muted: 'no schedule yet' };
    return `${describeCron(schedule.cron)}${schedule.tz ? ` · ${schedule.tz}` : ''}`;
}

/** The trigger card's line, per kind. */
export function triggerSummary(node: AnyNode, t: Translate): Summary {
    switch (node.kind || 'manual') {
        case 'schedule':
            return scheduleSummary(node);
        case 'app_event':
            return node.appEvent ? appEventText(node.appEvent as { provider?: string; event?: string }) : { muted: 'no event chosen yet' };
        case 'agent_call':
            return agentCallSummary(node);
        case 'layer_input':
        case 'app_trigger':
            return inputsSummary(node, t);
        case 'form':
            return formSummary(node);
        case 'webhook':
            return 'Runs when a system calls its URL';
        case 'manual':
            return 'Runs on the Run button';
        default:
            return '';
    }
}

/**
 * The trigger's name: the author's label, else the name a freshly added
 * trigger of its kind gets (the web card's `${kindLabel} trigger` fallback
 * doubles the word: "Webhook trigger trigger").
 */
export function triggerName(node: AnyNode): string {
    return str(node.label).trim() || defaultTriggerLabel(node.kind);
}

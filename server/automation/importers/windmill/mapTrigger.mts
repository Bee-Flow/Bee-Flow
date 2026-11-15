/**
 * How a Windmill flow starts, as a Bee Flow trigger (PLAN B3 mapTrigger.mts, research 06 §C.4).
 *
 *   dialect A (CORE:LISTEN_TO_EVENT) and B (a native trigger)  -> app_event nextcloud + filter
 *   a schedule (6-field cron with seconds)                      -> schedule (5 fields, seconds dropped)
 *   an HTTP route / the implicit webhook                        -> webhook (a NEW url; the caller re-points)
 *   a manual flow with an input schema                          -> form (fields from the schema)
 *   e-mail, Kafka, NATS, SQS, MQTT, AMQP, GCP, Azure, Postgres,
 *   WebSocket                                                    -> not migrated (reported)
 *
 * The first trigger found becomes the primary one; more Nextcloud events,
 * schedules and webhooks become `definition.triggers[]` (the secondary kinds
 * the model allows, core/automationModel/constants.js SECONDARY_TRIGGER_KINDS).
 * The answer also says what `flow_input` is at run time (`payload`), which the
 * expression scope uses to re-map `flow_input.*`.
 */

import { createRequire } from 'node:module';
import type { JsonObject, WmBundle, WmFlow } from './ir.mts';
import type { ReportBuilder } from './report.mts';
import { eventForClass } from './eventClasses.mts';
import { mapEventFilter } from './mapFilter.mts';
import { WEBHOOK_HEADER_TOKEN_AUTH } from './targetNames.mts';
import { asObject, entries, isIdentifier, isObject, str } from './util.mts';

const nodeRequire = createRequire(import.meta.url);
const { parseCron } = nodeRequire('../../cron') as { parseCron: (cron: string) => unknown };

export type PayloadKind = 'nextcloud' | 'schedule' | 'webhook' | 'form' | 'manual';

export interface TriggerResult {
    trigger: Record<string, unknown>;
    triggers: Array<Record<string, unknown>>;
    payload: PayloadKind;
    /** The Nextcloud event of the primary trigger (for the payload re-map). */
    event: string | null;
    /** Schedule args: `flow_input.<name>` reads `vars.<name>` on a schedule. */
    vars: Record<string, unknown>;
    /** The webhook auth to set up after import, when a webhook was made. */
    suggestedWebhookAuth?: string;
}

interface Candidate {
    kind: 'app_event' | 'schedule' | 'webhook';
    node: Record<string, unknown>;
    event?: string;
}

const UNSUPPORTED_KINDS = new Set(['email', 'kafka', 'nats', 'sqs', 'mqtt', 'amqp', 'gcp', 'azure', 'postgres', 'websocket']);

export function mapTriggers(flow: WmFlow, bundle: WmBundle, report: ReportBuilder): TriggerResult {
    const found: Candidate[] = [
        ...listenCandidates(flow, report),
        ...nativeCandidates(flow, bundle, report),
        ...scheduleCandidates(flow, bundle, report),
        ...httpCandidates(flow, bundle, report),
    ];
    const vars = scheduleArgs(flow, bundle);
    const result = found.length ? fromCandidates(found, report) : manualTrigger(flow, report);
    result.vars = vars;
    if (found.length) report.warn('trigger_switch_off', 'Switch the Windmill trigger off (or delete the flow there) once this automation is active, or every event runs twice.');
    return result;
}

function fromCandidates(found: Candidate[], report: ReportBuilder): TriggerResult {
    const [first, ...rest] = found;
    const trigger = { id: 'trg', type: 'trigger', ...first.node };
    const triggers = rest.map((c, i) => ({ id: `trg_${i + 2}`, type: 'trigger', ...c.node }));
    const payload: PayloadKind = first.kind === 'app_event' ? 'nextcloud' : first.kind === 'schedule' ? 'schedule' : 'webhook';
    const families = new Set(found.filter((c) => c.event).map((c) => c.event?.split('.')[0]));
    if (families.size > 1) report.warn('trigger_approximated', 'The flow starts on Nextcloud events of different kinds; the steps read the fields of the first one. Check the steps for the other triggers.');
    const out: TriggerResult = { trigger, triggers, payload, event: first.event ?? null, vars: {} };
    if (found.some((c) => c.kind === 'webhook')) out.suggestedWebhookAuth = WEBHOOK_HEADER_TOKEN_AUTH;
    return out;
}

// ── Nextcloud events ─────────────────────────────────────────────────────

function eventCandidate(cls: string, filter: unknown, userIdFilter: string | undefined, report: ReportBuilder): Candidate | null {
    const mapped = eventForClass(cls);
    if (!mapped) {
        report.warn('trigger_unsupported', `The Nextcloud event ${cls} has no Bee Flow trigger.`);
        return null;
    }
    if ('note' in mapped) report.warn('trigger_approximated', `${cls}: ${mapped.note}`);
    const f = mapEventFilter(mapped.event, filter, userIdFilter);
    const appEvent: Record<string, unknown> = { provider: 'nextcloud', event: mapped.event, filter: {} };
    if (f.kind === 'filter') {
        appEvent.filter = f.filter;
        for (const n of f.notes) report.warn('trigger_approximated', n);
    } else {
        report.ai({ wmId: 'trigger', stepId: null, title: 'Rebuild the trigger filter', why: f.reason, source: f.original });
        report.warn('trigger_approximated', 'The event filter could not be translated: the trigger now starts on every such event until the filter is set again.');
    }
    return { kind: 'app_event', event: mapped.event, node: { kind: 'app_event', label: labelOf(mapped.event), appEvent } };
}

function labelOf(event: string): string {
    return `Nextcloud: ${event}`;
}

function listenCandidates(flow: WmFlow, report: ReportBuilder): Candidate[] {
    if (!flow.listenEvents) return [];
    return flow.listenEvents.events
        .map((cls) => eventCandidate(cls, flow.listenEvents?.filters, undefined, report))
        .filter((c): c is Candidate => c !== null);
}

function nativeCandidates(flow: WmFlow, bundle: WmBundle, report: ReportBuilder): Candidate[] {
    const out: Candidate[] = [];
    for (const t of bundle.nativeTriggers.filter((n) => n.scriptPath === flow.path)) {
        if (t.service !== 'nextcloud') {
            report.warn('trigger_unsupported', `The ${t.service} native trigger (${t.file}) is not migrated.`);
            continue;
        }
        if (!t.event) { report.warn('read_problem', `${t.file} names no event.`); continue; }
        const c = eventCandidate(t.event, t.eventFilter, t.userIdFilter, report);
        if (c) out.push(c);
    }
    return out;
}

// ── Schedules ────────────────────────────────────────────────────────────

const MACROS: Record<string, string> = {
    '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

/** A Windmill cron (6 fields with seconds, or 5, or a macro) as a 5-field cron, or a reason it is not one. */
export function toFiveFieldCron(cron: string): { cron: string; secondsDropped: boolean } | { problem: string } {
    const text = cron.trim();
    if (MACROS[text]) return { cron: MACROS[text], secondsDropped: false };
    const fields = text.split(' ').filter(Boolean);
    let five = fields;
    let secondsDropped = false;
    if (fields.length === 6 || fields.length === 7) {
        if (fields.length === 7 && fields[6] !== '*') return { problem: `"${cron}" names a year; a Bee Flow schedule has no year field.` };
        secondsDropped = fields[0] !== '0';
        five = fields.slice(1, 6);
    } else if (fields.length !== 5) return { problem: `"${cron}" is not a cron pattern of 5 or 6 fields.` };
    five = five.map((f) => (f === '?' ? '*' : f));
    if (five.some((f) => f.includes('L') || f.includes('W') || f.includes('#'))) return { problem: `"${cron}" uses L, W or #, which a Bee Flow schedule does not read.` };
    const out = five.join(' ');
    try { parseCron(out); } catch (e) { return { problem: `"${cron}" does not read as a cron pattern (${e instanceof Error ? e.message : String(e)}).` }; }
    return { cron: out, secondsDropped };
}

function scheduleCandidates(flow: WmFlow, bundle: WmBundle, report: ReportBuilder): Candidate[] {
    const out: Candidate[] = [];
    for (const s of bundle.schedules.filter((x) => x.scriptPath === flow.path)) {
        const five = toFiveFieldCron(s.cron);
        const schedule: Record<string, unknown> = { cron: '' };
        if ('problem' in five) {
            report.ai({ wmId: 'trigger', stepId: null, title: 'Set the schedule', why: five.problem, source: s.cron });
        } else {
            schedule.cron = five.cron;
            if (five.secondsDropped) report.warn('schedule_seconds', `The schedule "${s.cron}" fired on a second other than 0; Bee Flow schedules run on whole minutes.`);
        }
        if (s.timezone) schedule.tz = s.timezone;
        if (s.enabled === false) report.warn('trigger_approximated', `The schedule ${s.file} was switched off in Windmill.`);
        out.push({ kind: 'schedule', node: { kind: 'schedule', label: 'Schedule', schedule } });
    }
    return out;
}

function scheduleArgs(flow: WmFlow, bundle: WmBundle): Record<string, unknown> {
    const s = bundle.schedules.find((x) => x.scriptPath === flow.path && isObject(x.args));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries(s?.args)) if (!(typeof v === 'string' && (v.startsWith('$res:') || v.startsWith('$var:')))) out[k] = v;
    return out;
}

// ── HTTP routes, e-mail and the rest ─────────────────────────────────────

function httpCandidates(flow: WmFlow, bundle: WmBundle, report: ReportBuilder): Candidate[] {
    const out: Candidate[] = [];
    for (const t of bundle.otherTriggers.filter((x) => x.scriptPath === flow.path)) {
        if (t.kind === 'http') {
            report.warn('new_webhook_url', `The HTTP route ${t.httpMethod ?? 'POST'} /${t.routePath ?? ''} becomes a Bee Flow webhook with a new address: point the caller at it and let it sign its requests, or give it a header token.`);
            if (t.requestType && t.requestType !== 'async') report.warn('option_dropped', 'The route answered with the flow\'s result; a Bee Flow webhook answers 202 at once.');
            out.push({ kind: 'webhook', node: { kind: 'webhook', label: 'Webhook' } });
        } else if (t.kind === 'email') {
            report.warn('trigger_unsupported', `The e-mail trigger (${t.file}) is not migrated: choose a mailbox trigger (Gmail, Outlook or Nextcloud Mail) for it.`);
        } else {
            const what = UNSUPPORTED_KINDS.has(t.kind) ? `The ${t.kind} trigger` : `The trigger ${t.file}`;
            report.warn('trigger_unsupported', `${what} is not migrated.`);
        }
    }
    return out;
}

// ── A flow started by hand ───────────────────────────────────────────────

/** Event family a Nextcloud payload schema describes (`event.node`, `event.form`, …), or null. */
function inferredEvent(schema: JsonObject | undefined): { event: string; certain: boolean } | null {
    const props = asObject(schema?.properties);
    if (!isObject(props.event) || !(isObject(props.authentication) || isObject(props.user))) return null;
    const ev = asObject(asObject(props.event).properties);
    if (isObject(ev.form) || isObject(ev.submission)) return { event: 'forms.submitted', certain: true };
    if (isObject(ev.node)) return { event: 'file.new', certain: false };
    if (ev.tableId !== undefined || ev.rowId !== undefined) return { event: 'tables.row.added', certain: false };
    if (ev.tagId !== undefined || ev.objectIds !== undefined) return { event: 'file.tagged', certain: false };
    return { event: 'file.new', certain: false };
}

function eventFromSchema(flow: WmFlow, report: ReportBuilder): TriggerResult | null {
    const inferred = inferredEvent(flow.schema);
    if (!inferred) return null;
    report.warn('trigger_switch_off', 'Switch the Windmill trigger off (or delete the flow there) once this automation is active, or every event runs twice.');
    if (inferred.certain) {
        report.warn('trigger_approximated', `The export has no trigger file; the flow reads a ${inferred.event} event, so it starts on that event. Add a filter (which form) on the trigger.`);
        const appEvent = { provider: 'nextcloud', event: inferred.event, filter: {} };
        return { trigger: { id: 'trg', type: 'trigger', kind: 'app_event', label: labelOf(inferred.event), appEvent }, triggers: [], payload: 'nextcloud', event: inferred.event, vars: {} };
    }
    report.ai({ wmId: 'trigger', stepId: null, title: 'Pick the Nextcloud event that starts this flow', why: `The export has no trigger file; the flow reads a Nextcloud event (it looks like ${inferred.event}). The trigger is "manual" until you pick the event.` });
    return { trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual' }, triggers: [], payload: 'nextcloud', event: inferred.event, vars: {} };
}

function manualTrigger(flow: WmFlow, report: ReportBuilder): TriggerResult {
    const fromSchema = eventFromSchema(flow, report);
    if (fromSchema) return fromSchema;
    const fields = formFields(flow.schema, report);
    if (fields.length) {
        const form = { title: flow.summary.slice(0, 120), fields };
        return { trigger: { id: 'trg', type: 'trigger', kind: 'form', label: 'Form', form }, triggers: [], payload: 'form', event: null, vars: {} };
    }
    return { trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual' }, triggers: [], payload: 'manual', event: null, vars: {} };
}

export function formFields(schema: JsonObject | undefined, report: ReportBuilder): Array<Record<string, unknown>> {
    const props = asObject(schema?.properties);
    const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const out: Array<Record<string, unknown>> = [];
    for (const [name, raw] of entries(props)) {
        const p = asObject(raw);
        const format = str(p.format) ?? '';
        if (format.startsWith('resource-')) continue;
        if (!isIdentifier(name, { dollar: false, letterFirst: true, maxLength: 60 })) { report.warn('option_dropped', `The input "${name}" has a name a form question cannot have; add it again by hand.`); continue; }
        const field: Record<string, unknown> = { name, label: str(p.description) ?? str(p.title) ?? name, type: fieldType(p) };
        if (Array.isArray(p.enum)) field.options = p.enum.filter((o) => typeof o === 'string');
        if (required.has(name)) field.required = true;
        out.push(field);
    }
    return out;
}

function fieldType(p: Record<string, unknown>): string {
    if (Array.isArray(p.enum)) return 'select';
    if (p.type === 'integer' || p.type === 'number') return 'number';
    if (p.type === 'boolean') return 'checkbox';
    if (p.format === 'date' || p.format === 'date-time') return 'date';
    if (p.format === 'email') return 'email';
    return 'text';
}

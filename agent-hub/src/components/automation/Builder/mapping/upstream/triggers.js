/**
 * The groups a TRIGGER contributes: its payload (`trigger.output.*`, whatever
 * kind fired) and the non-payload facts a run knows about it (`trigger.kind`,
 * `trigger.event`, … — one "Trigger info" group for the whole graph, however
 * many triggers the automation has).
 */
import { walkRelativePath } from '../../../../../utils/bindingHelpers';
import { samplePlaceholderFor } from './sampleFields';
import { pickSample } from './formAnswers';

/**
 * The non-payload facts a run knows about its trigger, as a sample object in
 * the shape of runState.trigger (minus `output`). Derived from the primary
 * trigger; a secondary trigger fires with its own values at run time.
 */
export function triggerMetaSample(definition) {
    const t = definition?.trigger || {};
    const kind = t.kind || 'manual';
    return {
        id: t.id || 'trg',
        kind,
        source: kind,
        label: typeof t.label === 'string' ? t.label : null,
        provider: t.appEvent?.provider || null,
        event: t.appEvent?.event || null,
        firedAt: new Date().toISOString(),
        schedule: t.schedule ? { cron: t.schedule.cron || null, tz: t.schedule.tz || null, scheduledFor: null } : null,
    };
}

/**
 * The "Trigger info" picker group: `trigger.kind`, `trigger.event`, … as
 * declared by the server catalog (`catalog.triggerMeta`), so the client never
 * hardcodes the list. Null when the catalog predates the key.
 */
export function describeTriggerMeta(definition, catalog) {
    const fields = Array.isArray(catalog?.triggerMeta) ? catalog.triggerMeta : null;
    if (!fields || fields.length === 0) return null;
    const sample = triggerMetaSample(definition);
    const kinds = new Set([(definition?.trigger?.kind) || 'manual']);
    const extra = Array.isArray(definition?.triggers) ? definition.triggers : [];
    for (const t of extra) kinds.add(t?.kind || 'manual');
    const shown = fields.filter(f => metaFieldApplies(f.key, kinds, definition, extra));
    if (shown.length === 0) return null;
    return {
        id: '__trigger_meta',
        label: 'Trigger info',
        kind: 'trigger_meta',
        basePath: 'trigger',
        sample,
        fields: shown.map(f => ({
            key: f.key,
            path: f.path || `trigger.${f.key}`,
            // The catalog's own sample is an example from ANOTHER trigger kind
            // ("New mail", a weekday cron): only fields the actual trigger
            // produces are listed, and they show what that trigger has.
            sample: walkRelativePath(f.key, sample) ?? null,
        })),
    };
}

/**
 * Whether a trigger-info field exists for the trigger kinds this automation
 * has. kind/source/id/firedAt are on every run; the rest belong to one kind
 * (the catalog's `note` says so): provider + event to app events, the cron to
 * schedules, `label` only once the trigger carries one, and `scheduledFor`
 * only for an ADDITIONAL schedule trigger (the primary one has no slot).
 */
function metaFieldApplies(key, kinds, definition, extra) {
    switch (key) {
        case 'label': return typeof definition?.trigger?.label === 'string' && definition.trigger.label !== '';
        case 'provider':
        case 'event': return kinds.has('app_event');
        case 'schedule.cron': return kinds.has('schedule');
        case 'schedule.scheduledFor': return extra.some(t => t?.kind === 'schedule');
        default: return true;
    }
}

export function describeTrigger(trigger, triggerOutputs) {
    const kind = trigger.kind || 'manual';
    // Declared-params triggers (a flowlet's input contract, or an app
    // trigger's Studio-App inputs) surface their params directly as bindable
    // fields — no catalog round-trip; the author's declaration IS the shape.
    if (kind === 'layer_input' || kind === 'app_trigger') {
        const params = Array.isArray(trigger.params) ? trigger.params : [];
        const sample = Object.fromEntries(params.map(p => [p.name, samplePlaceholderFor(p.type)]));
        return {
            id: trigger.id,
            label: kind === 'app_trigger' ? 'Studio App inputs' : 'Flowlet input',
            kind: 'trigger',
            basePath: 'trigger.output',
            sample,
            fields: params.map(p => ({
                key: p.name,
                path: `trigger.output.${p.name}`,
                sample: samplePlaceholderFor(p.type),
            })),
        };
    }
    // A hosted form's answers ARE its declared fields, so they are bindable
    // from the moment the author declares them — waiting for a first real
    // submission would leave every downstream step un-mappable.
    if (kind === 'form') {
        const fields = Array.isArray(trigger.form?.fields) ? trigger.form.fields.filter(f => f?.name) : [];
        const sampleFor = (f) => (f.type === 'checkbox' ? true
            : f.type === 'number' ? 42
            : f.type === 'date' ? '2026-01-31'
            : f.type === 'file' ? { kind: 'form_upload', filename: 'attachment.pdf' }
            // A picked record, as the run receives it: the reference the person
            // chose, plus the text that was read from it. Shown even when the
            // question only takes one, because `.text` is what a downstream
            // step binds and it has to be visible to be draggable.
            : f.type === 'app_pick' ? pickSample(f)
            : f.type === 'email' ? 'visitor@example.com'
            : f.label || 'answer');
        return {
            id: trigger.id,
            label: 'Form answers',
            kind: 'trigger',
            basePath: 'trigger.output',
            sample: Object.fromEntries(fields.map(f => [f.name, sampleFor(f)])),
            fields: fields.map(f => ({
                key: f.name,
                path: `trigger.output.${f.name}`,
                sample: sampleFor(f),
            })),
        };
    }
    let key = `__${kind}`;
    if (kind === 'app_event' && trigger.appEvent) {
        key = `${trigger.appEvent.provider}.${trigger.appEvent.event}`;
    }
    const entry = triggerOutputs[key] || triggerOutputs['__manual'] || { fields: [], sample: {} };
    return {
        id: trigger.id,
        label: triggerLabel(trigger),
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: entry.sample || {},
        fields: (entry.fields || []).map(f => ({
            key: f.key,
            path: `trigger.output.${f.key}`,
            sample: f.sample,
        })),
    };
}

function triggerLabel(t) {
    const k = t.kind || 'manual';
    if (k === 'manual') return 'Trigger (manual)';
    if (k === 'schedule') return 'Trigger (schedule)';
    if (k === 'webhook') return 'Trigger (webhook)';
    if (k === 'form') return 'Trigger (form)';
    if (k === 'layer_input') return 'Flowlet input';
    if (k === 'app_trigger') return 'Trigger (Studio App)';
    if (k === 'app_event' && t.appEvent) return `Trigger (${t.appEvent.provider} · ${t.appEvent.event})`;
    return 'Trigger';
}

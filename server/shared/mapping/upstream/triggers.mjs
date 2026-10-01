/**
 * The groups a TRIGGER contributes: its payload (`trigger.output.*`, whatever
 * kind fired) and the non-payload facts a run knows about it (`trigger.kind`,
 * `trigger.event`, …): one "Trigger info" group for the whole graph, however
 * many triggers the routine has.
 */
import { walkRelativePath } from '../legacy.mjs';
import { fieldsFromSample, makeNode, samplePlaceholderFor } from '../fields.mjs';
import { groupLabel, resolveEnv } from './env.mjs';
import { answersSample } from './formAnswers.mjs';
import { TRIGGER_BASE } from './sampleFields.mjs';

/**
 * The non-payload facts a run knows about its trigger, as a sample object in
 * the shape of runState.trigger (minus `output`). Derived from the primary
 * trigger; a secondary trigger fires with its own values at run time.
 */
export function triggerMetaSample(definition, env) {
    const t = definition?.trigger || {};
    const kind = t.kind || 'manual';
    return {
        id: t.id || 'trg',
        kind,
        source: kind,
        label: typeof t.label === 'string' ? t.label : null,
        provider: t.appEvent?.provider || null,
        event: t.appEvent?.event || null,
        firedAt: resolveEnv(env).now().toISOString(),
        schedule: t.schedule ? { cron: t.schedule.cron || null, tz: t.schedule.tz || null, scheduledFor: null } : null,
    };
}

/**
 * The "Trigger info" picker group: `trigger.kind`, `trigger.event`, … as
 * declared by the server catalog (`catalog.triggerMeta`), so no client
 * hardcodes the list. Null when the catalog predates the key. These are
 * run metadata, not the payload: their Source root is `run` once picks exist
 * (M2); here they carry the legacy path the catalog gives and no Source.
 */
export function describeTriggerMeta(definition, catalog, env) {
    const fields = Array.isArray(catalog?.triggerMeta) ? catalog.triggerMeta : null;
    if (!fields || fields.length === 0) return null;
    const sample = triggerMetaSample(definition, env);
    return {
        id: '__trigger_meta',
        label: groupLabel(env, 'trigger_info', 'Trigger info'),
        kind: 'trigger_meta',
        basePath: 'trigger',
        sample,
        fields: fields.map(f => makeNode(
            { source: null, text: f.path || `trigger.${f.key}`, rel: [f.key] },
            f.key,
            walkRelativePath(f.key, sample) ?? f.sample ?? null,
        )),
    };
}

function triggerGroup(trigger, label, sample) {
    return {
        id: trigger.id,
        label,
        kind: 'trigger',
        basePath: 'trigger.output',
        sample,
        fields: fieldsFromSample(sample, TRIGGER_BASE),
    };
}

export function describeTrigger(trigger, triggerOutputs, env) {
    const kind = trigger.kind || 'manual';
    // Declared-params triggers (a flowlet's input contract, or an app
    // trigger's Studio-App inputs) surface their params directly as bindable
    // fields: the author's declaration IS the shape. A flowlet param name is
    // not validated anywhere (the AI builder or an import can store `first
    // name`), so the path is written by formatSegment like every other.
    if (kind === 'layer_input' || kind === 'app_trigger') {
        const params = Array.isArray(trigger.params) ? trigger.params.filter(p => p && typeof p.name === 'string' && p.name) : [];
        const sample = Object.fromEntries(params.map(p => [p.name, samplePlaceholderFor(p.type)]));
        const label = kind === 'app_trigger'
            ? groupLabel(env, 'studio_app_inputs', 'Studio App inputs')
            : groupLabel(env, 'flowlet_input', 'Flowlet input');
        return triggerGroup(trigger, label, sample);
    }
    // A hosted form's answers ARE its declared fields, so they are bindable
    // from the moment the author declares them.
    if (kind === 'form') {
        return triggerGroup(trigger, groupLabel(env, 'form_answers', 'Form answers'), answersSample(trigger.form, env));
    }
    let key = `__${kind}`;
    if (kind === 'app_event' && trigger.appEvent) {
        key = `${trigger.appEvent.provider}.${trigger.appEvent.event}`;
    }
    const entry = triggerOutputs?.[key] || triggerOutputs?.__manual || { fields: [], sample: {} };
    const sample = entry.sample || {};
    // The catalog's declared keys are the fields; each opens to whatever the
    // sample holds under it.
    const fields = (entry.fields || [])
        .filter(f => f && typeof f.key === 'string' && f.key)
        .map(f => fieldsFromSample({ [f.key]: f.sample !== undefined ? f.sample : sample[f.key] }, TRIGGER_BASE)[0])
        .filter(Boolean);
    return {
        id: trigger.id,
        label: triggerLabel(trigger, env),
        kind: 'trigger',
        basePath: 'trigger.output',
        sample,
        fields,
    };
}

function triggerLabel(t, env) {
    const k = t.kind || 'manual';
    if (k === 'manual') return groupLabel(env, 'trigger_manual', 'Trigger (manual)');
    if (k === 'schedule') return groupLabel(env, 'trigger_schedule', 'Trigger (schedule)');
    if (k === 'webhook') return groupLabel(env, 'trigger_webhook', 'Trigger (webhook)');
    if (k === 'form') return groupLabel(env, 'trigger_form', 'Trigger (form)');
    if (k === 'layer_input') return groupLabel(env, 'flowlet_input', 'Flowlet input');
    if (k === 'app_trigger') return groupLabel(env, 'trigger_studio_app', 'Trigger (Studio App)');
    if (k === 'app_event' && t.appEvent) {
        return groupLabel(env, 'trigger_app_event', 'Trigger ({provider} · {event})', { provider: t.appEvent.provider, event: t.appEvent.event });
    }
    return groupLabel(env, 'node.trigger', 'Trigger');
}

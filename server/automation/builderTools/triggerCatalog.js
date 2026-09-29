/**
 * Trigger field/output-sample catalog for the builder, keyed by
 * `<provider>.<event>`.
 *
 * The data itself now lives with the integration that emits the event — see
 * automation/triggerSources/. This module is the projection the rest of the
 * builder already consumes, so nothing downstream had to change: an integration
 * declares its events once, and both the provider dropdown
 * (builderTools/triggerProviders.js) and the variable picker (here) read the
 * same declaration. Previously the two were separate hardcoded maps kept in
 * sync by a test, which is exactly what drifted.
 *
 * Hidden events are included: an event can be withdrawn from the dropdown while
 * automations that already use it keep resolving their trigger.output.* paths.
 */
const { listTriggerSources } = require('../triggerSources');

function eachDeclaredEvent(fn) {
    for (const src of listTriggerSources({ includeHidden: true })) {
        for (const ev of src.events || []) fn(`${src.id}.${ev.id}`, ev);
    }
}

function fieldsByEvent() {
    const out = {};
    eachDeclaredEvent((key, ev) => { out[key] = [...(ev.fields || [])]; });
    return out;
}

function outputSamples() {
    const out = {};
    eachDeclaredEvent((key, ev) => { out[key] = { ...(ev.sample || {}) }; });
    return out;
}

/**
 * The bare field names a `trigger.output.<field>` repair may assume — the
 * union over EVERY app_event trigger of the draft (primary + additional), so a
 * step wired under a secondary Gmail trigger gets the same bare-name repair
 * as one under a primary.
 */
function triggerFieldsFor(draft) {
    const { getEventDef } = require('../triggerSources');
    const out = [];
    for (const t of [draft?.trigger, ...(Array.isArray(draft?.triggers) ? draft.triggers : [])]) {
        if (!t || t.kind !== 'app_event') continue;
        const ev = getEventDef(t.appEvent?.provider, t.appEvent?.event);
        for (const f of (ev?.fields || [])) if (!out.includes(f)) out.push(f);
    }
    return out;
}

/**
 * Build a `<provider>.<event>` → { fields:[{key, sample}] } map for the client
 * catalog, so the VariableTree can show a realistic placeholder next to each
 * bindable path without needing a dry-run first.
 */
function buildTriggerOutputsCatalog() {
    const out = {};
    eachDeclaredEvent((key, ev) => {
        const sample = { ...(ev.sample || {}) };
        out[key] = {
            fields: (ev.fields || []).map(f => ({ key: f, sample: sample[f] })),
            sample,
        };
    });
    // Non-app_event triggers expose minimal output. Manual/schedule fire
    // with no user-supplied payload; `now` is always available via the
    // runtime so it's worth surfacing as a bindable path.
    out['__manual'] = { fields: [{ key: 'now', sample: new Date().toISOString() }], sample: { now: new Date().toISOString() } };
    out['__schedule'] = { fields: [{ key: 'now', sample: new Date().toISOString() }], sample: { now: new Date().toISOString() } };
    // Webhook contract (A14): trigger.output IS the raw JSON body the caller
    // POSTs — there is no `body`/`headers` wrapper. The old entry promised
    // trigger.output.body / trigger.output.headers, two paths that have never
    // existed at run time, so every binding built from the picker resolved
    // undefined. Headers live additively at trigger.headers (allowlisted;
    // events.js), outside `output` so they can't collide with body fields.
    out['__webhook'] = {
        fields: [],
        sample: {},
        note: 'trigger.output is the raw JSON body you POST — bind trigger.output.<yourField>. Request headers are at trigger.headers.<name>.',
    };
    // app_trigger fields are author-declared per automation (trigger.params)
    // and resolved client-side (mapping/upstream.js describeTrigger); the
    // empty entry keeps a stale FE from falling back to __manual's `now`.
    out['__app_trigger'] = { fields: [], sample: {} };
    // form fields are author-declared per automation (trigger.form.fields) and
    // resolved client-side (mapping/upstream.js describeTrigger) — same reason
    // as app_trigger. Submission metadata rides on trigger.headers, so it can
    // never collide with a field the author named.
    out['__form'] = {
        fields: [],
        sample: {},
        note: 'trigger.output is the answers keyed by field name — bind trigger.output.<fieldName>. submitted_at / form_page_id are at trigger.headers.<name>.',
    };
    return out;
}

/**
 * What a run knows about the trigger that fired, BESIDE `trigger.output` —
 * the same for every trigger kind (core/automationRunner/triggerState.js).
 * Shipped to the client as `catalog.triggerMeta` (a sibling key, so the
 * byte-pinned `triggerOutputs` catalog above stays untouched) and listed in the
 * builder guide, so a step reachable from several triggers can branch on
 * `trigger.kind` / `trigger.event`.
 */
const TRIGGER_META_FIELDS = Object.freeze([
    { key: 'kind', path: 'trigger.kind', sample: 'app_event', note: 'The trigger node the run entered through: app_event | schedule | webhook | form | manual | agent_call | app_trigger.' },
    { key: 'source', path: 'trigger.source', sample: 'app_event', note: 'How THIS run was started — "manual" for a test run of any trigger.' },
    { key: 'id', path: 'trigger.id', sample: 'trg', note: 'The trigger node id (trg for the primary trigger).' },
    { key: 'label', path: 'trigger.label', sample: 'New mail' },
    { key: 'provider', path: 'trigger.provider', sample: 'gmail', note: 'App events only.' },
    { key: 'event', path: 'trigger.event', sample: 'mail.new', note: 'App events only.' },
    { key: 'firedAt', path: 'trigger.firedAt', sample: '2026-09-03T07:00:00.000Z' },
    { key: 'schedule.cron', path: 'trigger.schedule.cron', sample: '0 7 * * 1-5', note: 'Schedule triggers only.' },
    { key: 'schedule.scheduledFor', path: 'trigger.schedule.scheduledFor', sample: '2026-09-03T07:00:00.000Z', note: 'Additional schedules only: the slot that fired.' },
]);

module.exports = { triggerFieldsFor, buildTriggerOutputsCatalog, TRIGGER_META_FIELDS };

// Back-compat surface: both maps were plain objects and are still re-exported
// by builderTools.js. They are computed per access from the registry, so a
// caller can never poison the declarations by mutating what it reads.
Object.defineProperty(module.exports, 'TRIGGER_FIELDS_BY_EVENT', { get: fieldsByEvent, enumerable: true });
Object.defineProperty(module.exports, 'TRIGGER_OUTPUT_SAMPLES', { get: outputSamples, enumerable: true });

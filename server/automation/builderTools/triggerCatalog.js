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
const { agentCallParams } = require('../agentCallContract');
const { PARAM_NAME_RE } = require('../appTriggerContract');
const { isDisplayField } = require('../formTriggerContract');

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
 * The inputs an author DECLARED on a trigger, as `[{ name, type }]` — the other
 * half of what `trigger.output` holds (an app_event's fields come from its
 * registry declaration, above):
 *   agent_call   parametersSchema.properties  — what the calling agent passes
 *   app_trigger  params                       — what the Studio App action passes
 *   form         form.fields                  — the answers, keyed by field name
 * `type` is the value's type for the ref check: string | number | boolean |
 * object | array | file. A name a path cannot address without brackets is left
 * out (the validator reports it), and so is a form's display field (a download
 * button is page furniture, never an answer).
 */
function declaredTriggerFields(trigger) {
    if (!trigger || typeof trigger !== 'object') return [];
    if (trigger.kind === 'agent_call') return agentCallParams(trigger).map(p => ({ name: p.name, type: p.type }));
    if (trigger.kind === 'app_trigger') {
        return (Array.isArray(trigger.params) ? trigger.params : [])
            .filter(p => p && typeof p.name === 'string' && PARAM_NAME_RE.test(p.name))
            .map(p => ({ name: p.name, type: typeof p.type === 'string' ? p.type : 'string' }));
    }
    if (trigger.kind === 'form') {
        const fields = Array.isArray(trigger.form?.fields) ? trigger.form.fields : [];
        return fields
            .filter(f => f && typeof f.name === 'string' && PARAM_NAME_RE.test(f.name) && !isDisplayField(f))
            .map(f => ({ name: f.name, type: formFieldType(f) }));
    }
    return [];
}

// What trigger.output.<name> holds for a form answer (formTriggerContract.coerceFieldValue).
function formFieldType(f) {
    if (f.type === 'number') return 'number';
    if (f.type === 'checkbox') return 'boolean';
    if (f.type === 'file') return 'file';
    if (f.type === 'app_pick') return f.multiple ? 'array' : 'object';
    return 'string';
}

/**
 * The bare field names a `trigger.output.<field>` repair may assume — the
 * union over EVERY trigger of the draft (primary + additional): the fields of
 * each app_event, and the inputs an agent_call, form or app_trigger declares.
 * A step wired under a secondary Gmail trigger gets the same bare-name repair
 * as one under a primary.
 */
function triggerFieldsFor(draft) {
    const { getEventDef } = require('../triggerSources');
    const out = [];
    const add = (f) => { if (!out.includes(f)) out.push(f); };
    for (const t of [draft?.trigger, ...(Array.isArray(draft?.triggers) ? draft.triggers : [])]) {
        if (!t) continue;
        if (t.kind === 'app_event') {
            const ev = getEventDef(t.appEvent?.provider, t.appEvent?.event);
            for (const f of (ev?.fields || [])) add(f);
        } else {
            for (const f of declaredTriggerFields(t)) add(f.name);
        }
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
    // agent_call arguments are author-declared per automation
    // (trigger.parametersSchema) and resolved client-side (mapping/upstream/
    // triggers.js describeTrigger); without this entry the picker fell back to
    // __manual and offered `now` instead of the arguments the agent passes.
    out['__agent_call'] = {
        fields: [],
        sample: {},
        note: 'trigger.output holds the arguments the calling agent passes — bind trigger.output.<argumentName>. There is no trigger.payload.',
    };
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

module.exports = { triggerFieldsFor, declaredTriggerFields, buildTriggerOutputsCatalog, TRIGGER_META_FIELDS };

// Back-compat surface: both maps were plain objects and are still re-exported
// by builderTools.js. They are computed per access from the registry, so a
// caller can never poison the declarations by mutating what it reads.
Object.defineProperty(module.exports, 'TRIGGER_FIELDS_BY_EVENT', { get: fieldsByEvent, enumerable: true });
Object.defineProperty(module.exports, 'TRIGGER_OUTPUT_SAMPLES', { get: outputSamples, enumerable: true });

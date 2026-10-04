/**
 * Per-graph validation: the rules that apply to ONE graph — the root
 * definition or a layer/Step mini-definition. Trigger shape and the
 * kind-specific trigger contracts (schedule, form, app_event, app_trigger),
 * step ids and types, edges and their labels, the DAG check, the call_layer /
 * call_block reference passes, and the walk that runs the per-step rules over
 * top-level steps and every step nested in a loop body / parallel branch.
 *
 * The per-step-type field rules themselves live in validate/stepRules.js; the
 * cross-graph passes (layers map, size ceilings, the draft/activate stage
 * ladder) live in validate/definition.js, which drives this module.
 */

// Cron is the schedule trigger's whole firing contract — parseCron is the same
// parser the scheduler and `POST /_schedule/preview` use, so "validates here"
// and "produces a next_run_at there" can never disagree. cron.js has no
// requires of its own, so pulling it in at module load is free.
const { parseCron } = require('../cron');
const { nextScheduledRunAt } = require('../holidays');
// The tz the row's schedule_tz column falls back to — read from the module that
// actually writes that column, so "what the validator checked" and "what the
// scheduler runs" can never drift apart.
const { DEFAULT_SCHEDULE_TZ } = require('../triggerColumns');
const { SECONDARY_TRIGGER_KINDS } = require('./constants');

/**
 * The schedule checks, shared by the primary trigger and every additional
 * schedule trigger. `base` is the already-prefixed path of the trigger node
 * (`trigger` or `triggers[<id>]`); every record hangs off `${base}.schedule…`
 * so the canvas maps it to the right node.
 *
 * Every "this schedule cannot fire" code is completeness-listed: a freshly
 * dropped schedule node has no schedule yet, and a cron is typed one character
 * at a time — so they warn while you build and block when you activate. Only
 * the outright shape error blocks at every stage.
 */
function checkScheduleTrigger(trigger, base, pushE) {
    const sched = trigger.schedule;
    if (sched !== undefined && sched !== null && !isObject(sched)) {
        pushE({ code: 'trigger.schedule_shape', severity: 'error', path: `${base}.schedule`, message: 'trigger.schedule must be an object { cron, tz? }.', hint: 'e.g. { cron: "0 9 * * 1-5", tz: "Europe/Amsterdam" }.' });
        return;
    }
    const cron = isObject(sched) ? sched.cron : undefined;
    const tz = (isObject(sched) && typeof sched.tz === 'string' && sched.tz.trim())
        ? sched.tz.trim() : DEFAULT_SCHEDULE_TZ;
    if (typeof cron !== 'string' || !cron.trim()) {
        pushE({ code: 'trigger.schedule_missing', severity: 'error', path: `${base}.schedule.cron`, message: 'Schedule trigger has no schedule — it can never fire.', hint: 'Open the trigger and pick a time (or a custom pattern), e.g. cron "0 9 * * 1-5" = every weekday at 09:00.' });
        return;
    }
    // Handoff 5 "skip public holidays": a flag, nothing else.
    const skipHolidays = sched.skipHolidays;
    if (skipHolidays !== undefined && skipHolidays !== null && typeof skipHolidays !== 'boolean') {
        pushE({ code: 'trigger.schedule_skip_holidays_shape', severity: 'error', path: `${base}.schedule.skipHolidays`, message: 'schedule.skipHolidays must be true or false.', hint: 'Set skipHolidays: true to leave Dutch public holidays out, or remove it.' });
    }
    let parsed = true;
    try { parseCron(cron); }
    catch (e) {
        parsed = false;
        pushE({ code: 'trigger.schedule_cron_invalid', severity: 'error', path: `${base}.schedule.cron`, message: `Schedule trigger has an unusable pattern "${cron}" — ${e.message}.`, hint: 'Five space-separated fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5".' });
    }
    // Parsing is not enough. parseCron DROPS out-of-range values instead of
    // rejecting them ("99 * * * *" yields an empty minute set) and an
    // impossible calendar date ("0 0 31 2 *") is legal syntax — either way
    // nextRunAt returns null, the row is stored with next_run_at = NULL, and
    // the automation sits "active" without a single run. Ask the same question
    // the scheduler will: is there a next occurrence at all?
    if (!parsed) return;
    try {
        if (nextScheduledRunAt(cron, tz, Date.now(), { skipHolidays: skipHolidays === true }) === null) {
            pushE({ code: 'trigger.schedule_never_fires', severity: 'error', path: `${base}.schedule.cron`, message: `Schedule "${cron}" has no run time in the next year — this automation would never fire.`, hint: 'Check the day/month combination (e.g. 31 February) and that every value is in range: minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6.' });
        }
    } catch (e) {
        // The only thing left that can throw here is the timezone:
        // Intl.DateTimeFormat rejects an unknown IANA name, and the scheduler
        // would hit the same RangeError when it tried to advance the row.
        pushE({ code: 'trigger.schedule_tz_invalid', severity: 'error', path: `${base}.schedule.tz`, message: `Schedule timezone "${tz}" is not a known timezone — ${e.message}.`, hint: `Use an IANA name like "Europe/Amsterdam" or "UTC", or leave it empty for ${DEFAULT_SCHEDULE_TZ}.` });
    }
}

// §WS5 — pure graph/string helpers extracted into validate/helpers.js so this
// file holds the validation RULES, not the plumbing. Behaviour is unchanged.
const { isObject, validatePosition, topoOrder } = require('./helpers');
const { collectCallLayerSteps, validateCallLayerStep } = require('./callLayer');
const { collectCallBlockSteps, validateCallBlockStep } = require('./callBlock');
const {
    VALID_STEP_TYPES, KNOWN_EDGE_LABELS, EDGE_COLOR_KEYS,
    ON_ERROR_SOURCE_TYPES, ON_ERROR_FORBIDDEN_SOURCE_TYPES, BRANCHER_TYPES,
    TERMINAL_STEP_TYPES,
} = require('./constants');

/**
 * Hoe een rand ná een terminale stap wordt gemeld — per soort, omdat de
 * ERNST per soort verschilt en de regel niet.
 *
 * `stop_error` bestond al toen deze regel er nog niet was, dus daar blijft het
 * een WAARSCHUWING: bestaande definities moeten blijven opslaan én activeren,
 * de auteur wordt het alleen eindelijk verteld (B9). `return_to_app` is nieuw —
 * er is geen gisteren om te bewaren — dus daar is het een FOUT. Wel
 * completeness-listed (validate/completenessCodes.js): halverwege bouwen mag,
 * live zetten niet.
 *
 * Elke terminale soort MOET hier een regel hebben; de drifttest
 * (automation/validate/terminalSteps.test.js) faalt op een soort die
 * TERMINAL_STEP_TYPES wel noemt en deze tabel niet.
 */
const TERMINAL_EDGE_RULES = new Map([
    ['stop_error', {
        code: 'edge.after_stop_error', severity: 'warning',
        message: (from, to) => `Edge ${from} → ${to}: steps after Stop-and-Error can never run.`,
        hint: 'Stop-and-Error halts the run. Remove this edge, or move the downstream steps before the stop.',
    }],
    ['return_to_app', {
        code: 'edge.after_terminal', severity: 'error',
        message: (from, to) => `Edge ${from} → ${to}: steps after Back-to-the-app can never run.`,
        hint: 'Back to the app ends the run and hands the app its instructions. Remove this edge, or move the downstream steps before it.',
    }],
]);
const { checkBindableStepId } = require('./fieldChecks');
const { createStepChecker, checkPinnedOutput } = require('./stepRules');

/**
 * Walk a graph (root definition or a layer mini-definition) collecting every
 * call_layer step — including those nested inside loop bodies and parallel
 * branches. Returns [{ step, path }] with builder-style paths.
 */

const NODE_SEG_RE = /^(trigger|triggers|steps)(?:\[(.+)\])?$/;

/**
 * The step a record's path addresses, as an id the canvas can select.
 *
 * Paths are not uniform, and deliberately so: a top-level step is addressed
 * by INDEX (`steps[3]`) except where the rule already knew the id
 * (`steps[<id>]`, form_page.input_after_ending); a trigger by id where it has
 * one (`triggers[<id>]`, C7); a nested step always by id
 * (`steps[3].body.steps[<id>]`). This resolves whichever form it meets against
 * the graph, and the DEEPEST addressed node wins — a record about a loop-body
 * step is about that step, not its loop. Null when the path names no node
 * (`edges[2]`, `piiLineColors`, an index that no longer exists).
 */
function stepIdFromPath(graph, pathPrefix, path) {
    if (typeof path !== 'string' || !path) return null;
    const local = pathPrefix && path.startsWith(pathPrefix) ? path.slice(pathPrefix.length) : path;
    const byToken = (list, tok) => {
        if (!Array.isArray(list)) return null;
        const hit = list.find((s) => isObject(s) && s.id === tok);
        if (hit) return tok;
        if (!/^\d+$/.test(tok)) return null;
        const at = list[Number(tok)];
        return isObject(at) && typeof at.id === 'string' && at.id ? at.id : null;
    };
    let found = null;
    let topLevel = true;
    for (const part of local.split('.')) {
        const m = NODE_SEG_RE.exec(part);
        if (!m) continue;
        const [, seg, tok] = m;
        if (seg === 'trigger') {
            if (!tok && isObject(graph.trigger) && typeof graph.trigger.id === 'string') found = graph.trigger.id;
        } else if (seg === 'triggers') {
            if (tok) found = byToken(graph.triggers, tok) ?? found;
        } else if (tok && tok !== '?') {
            // First `steps[…]` is the top-level list (index or id); anything
            // after it is a loop body / parallel branch, addressed by id.
            found = (topLevel ? byToken(graph.steps, tok) : tok) ?? found;
            topLevel = false;
        }
    }
    return found;
}

/** The Finding targetRef for one record of this graph — see validateGraph. */
function automationTargetRef(graph, pathPrefix, path, target) {
    const ref = { kind: 'automation', id: target?.id ?? null };
    if (target?.title) ref.title = target.title;
    if (typeof path === 'string' && path) {
        ref.path = path;
        const stepId = stepIdFromPath(graph, pathPrefix, path);
        if (stepId) ref.stepId = stepId;
    }
    return ref;
}

/**
 * Validate ONE graph — the root definition or a layer mini-definition.
 * Pushes records onto opts.errors / opts.warnings with `pathPrefix`
 * prepended to every path ('' for root, 'layers.<key>.' for layers).
 * Every record also carries `kind: 'automation'` and a `targetRef`
 * (core/findings/finding.js); `opts.target` = `{ id, title }` of the
 * automation being validated fills in the id, and is optional.
 *
 * opts:
 *   errors / warnings   — shared record arrays (mutated)
 *   scope               — 'root' | 'layer'
 *   layers              — the ROOT layers map (for call_layer reference checks)
 *   availableTools / toolRequiredParams / deliverableEvents /
 *   availableAgents /
 *   topicClassifier     — as on validateDefinition.
 *
 * Mirrors the original single-graph behaviour: stops validating THIS graph
 * at the same phase boundaries the original function early-returned at
 * (shape → ids/edges → DAG → per-step), without aborting sibling graphs.
 */
function validateGraph(graph, pathPrefix, opts) {
    const { errors, warnings, scope = 'root', layers = {}, availableTools = null, toolRequiredParams = null, deliverableEvents = null, availableBlocks = null, knownConnectionIds = null, availableAgents = null, topicClassifier = null, target = null } = opts;
    // Every record that leaves this graph carries the two fields the shared
    // Finding shape adds (core/findings/finding.js): `kind`, and a `targetRef`
    // naming WHICH automation and — when the path addresses one — WHICH step.
    // Purely additive: severity and the draft/activate ladder are untouched,
    // validate/definition.js still decides what blocks at which stage. The
    // automation id is whatever the caller threaded in as opts.target
    // ({ id, title }); validateGraph itself only ever sees a definition.
    const withTarget = (rec) => (rec.targetRef ? rec : { ...rec, kind: 'automation', targetRef: automationTargetRef(graph, pathPrefix, rec.path, target) });
    const pushE = (rec) => errors.push(withTarget(rec));
    const pushW = (rec) => warnings.push(withTarget(rec));
    const startErrors = errors.length;
    const p = (s) => pathPrefix + s;
    // Contract scopes (layer + block) share the input/output-contract rules:
    // a fixed layer_input trigger, exactly one layer_output, no approval, no
    // nested layers. 'block' is a standalone Step (kind='block') validated at
    // the document root; 'layer' is an inline flowlet.
    const isContractScope = scope === 'layer' || scope === 'block';
    const contractNoun = scope === 'block' ? 'Step' : 'Layer';

    if (!isObject(graph.trigger)) pushE({ code: 'trigger.missing', severity: 'error', path: p('trigger'), message: 'Missing or invalid `trigger`.', hint: isContractScope ? `Every ${contractNoun} needs a layer_input trigger declaring its params.` : 'Call builder_propose_trigger before adding any steps.' });
    if (!Array.isArray(graph.steps)) pushE({ code: 'steps.not_array', severity: 'error', path: p('steps'), message: '`steps` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (!Array.isArray(graph.edges)) pushE({ code: 'edges.not_array', severity: 'error', path: p('edges'), message: '`edges` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (errors.length > startErrors) return;

    // Trigger — ensure it has an id and a kind.
    const trigger = graph.trigger;
    if (!trigger.id || typeof trigger.id !== 'string') pushE({ code: 'trigger.id_missing', severity: 'error', path: p('trigger.id'), message: 'trigger.id is required.', hint: 'Re-run builder_propose_trigger; it generates a stable id.' });
    if (isContractScope) {
        // Layer/Step graphs: the trigger is the input contract — kind is fixed.
        if (trigger.kind !== 'layer_input') {
            pushE({ code: 'layer.trigger_kind', severity: 'error', path: p('trigger.kind'), message: `${contractNoun} trigger kind must be 'layer_input' (got "${trigger.kind}").`, hint: `${contractNoun}s are invoked by their callers, not by their own triggers — set trigger.kind to 'layer_input' and declare params.` });
        }
        if (trigger.params !== undefined && !Array.isArray(trigger.params)) {
            pushE({ code: 'layer.params_shape', severity: 'error', path: p('trigger.params'), message: `${contractNoun} trigger.params must be an array of { name, type, required? }.`, hint: 'Use builder_set_layer_contract to declare the inputs.' });
        }
        // No document nesting — layers/Steps don't contain inline layers.
        if (graph.layers !== undefined) {
            pushE({ code: 'layers.nested', severity: 'error', path: p('layers'), message: `A ${contractNoun} cannot contain a nested \`layers\` map.`, hint: 'Move the nested layer up to definition.layers and reference it by key (sibling calls are allowed).' });
        }
    } else {
        if (!trigger.kind || typeof trigger.kind !== 'string') pushE({ code: 'trigger.kind_missing', severity: 'error', path: p('trigger.kind'), message: 'trigger.kind is required.', hint: 'Use one of: schedule, manual, webhook, form, app_event, agent_call, app_trigger.' });
        // app_trigger: the declared typed inputs a Studio App action must
        // provide (contract in automation/appTriggerContract.js). Params
        // absent = a zero-input trigger, which is legal.
        if (trigger.kind === 'app_trigger') {
            const { validateAppTriggerParams, validateAppTriggerRef } = require('../appTriggerContract');
            for (const issue of validateAppTriggerParams(trigger.params)) {
                pushE({ code: `app_trigger.${issue.code}`, severity: 'error', path: p(`trigger.${issue.path}`), message: issue.message, hint: issue.hint });
            }
            // The back-pointer to the button this automation was made from
            // ({ appId, screenId, nodeId }). Absent is legal; a HALF-written
            // one is not — it would render as "<app> · " with nothing after
            // it, and nothing downstream could tell that apart from an app
            // whose screen was deleted. Shape only: whether the ids still
            // resolve is a per-viewer question (appStudio/appRefLookup.js),
            // and an automation must not become unsaveable because someone else
            // deleted a screen.
            for (const issue of validateAppTriggerRef(trigger.appRef)) {
                pushE({ code: `app_trigger.${issue.code}`, severity: 'error', path: p(`trigger.${issue.path}`), message: issue.message, hint: issue.hint });
            }
        }
        // form: the fields the public page renders and the visitor fills in
        // (contract in automation/formTriggerContract.js). An empty form is a
        // completeness problem, not a shape error — see COMPLETENESS_CODES.
        if (trigger.kind === 'form') {
            const { validateFormTrigger } = require('../formTriggerContract');
            for (const issue of validateFormTrigger(trigger.form)) {
                pushE({ code: `form.${issue.code}`, severity: 'error', path: p(`trigger.${issue.path}`), message: issue.message, hint: issue.hint });
            }
        }
        // schedule: the cron IS the trigger. Until now nothing checked it here
        // at all, so `{ kind: 'schedule' }` with no cron sailed through the
        // draft AND the strict pass. Activated, that automation gets
        // trigger_type='schedule' with schedule_cron=NULL (see
        // triggerColumns.js) — claimDueAutomations selects on trigger_type +
        // next_run_at only, and the runner's post-run advance is gated on the
        // cron it does not have, so the row keeps a past next_run_at and
        // re-fires with live side effects on every 60s scheduler tick, forever.
        // Every "this schedule cannot fire" code below is completeness-listed:
        // a freshly dropped schedule node has no schedule yet, and a cron is
        // typed one character at a time — so they warn while you build and
        // block when you activate. Only the outright shape error blocks at
        // every stage.
        if (trigger.kind === 'schedule') checkScheduleTrigger(trigger, p('trigger'), pushE);
    }
    validatePosition(trigger.position, p('trigger'), pushE);

    // Pinned SAMPLE data on the trigger (BFSF-408/409/434) — the payload a
    // builder run enters with when nothing live arrived. The per-step checker
    // is never called for a trigger — the walk below skips `trigger.id` — so
    // the size / sentinel rules need their own hook, right here where the rest
    // of the trigger's shape is checked. The brancher half of the rule is a
    // no-op for a trigger (its type is not a brancher), which is why one
    // function serves both node kinds.
    checkPinnedOutput(trigger, p('trigger'), { pushE, isTrigger: true });

    // Deliverability warning (opt-in; root only — layer triggers are
    // layer_input): an app_event trigger whose event has no producer on this
    // install — neither a triggerBus poller nor a connector push subscription
    // — will activate but never fire. Non-blocking: push-only events are
    // deliverable on connector installs but not OAuth-only ones, so we warn
    // rather than block.
    if (scope === 'root' && deliverableEvents && trigger.kind === 'app_event') {
        const prov = trigger.appEvent?.provider;
        const ev = trigger.appEvent?.event;
        const set = prov && deliverableEvents[prov];
        if (set && ev && !set.has(ev)) {
            // Nextcloud push-only events need the Bee Flow ExApp connector push
            // pipeline (pending live validation). Surface that precisely so the
            // user isn't surprised; keep it a non-blocking warning.
            let pushPending = false;
            try { pushPending = prov === 'nextcloud' && require('../deliverableEvents').isPushPending(prov, ev); } catch { /* fall back to generic */ }
            const message = pushPending
                ? `Trigger event "${prov}.${ev}" requires the Bee Flow ExApp connector and is pending live validation — it will activate but may not fire yet.`
                : `Trigger event "${prov}.${ev}" has no delivery path on this install — it will activate but may never fire.`;
            pushW({ code: 'trigger.app_event_undeliverable', severity: 'warning', path: p('trigger.appEvent.event'), message, hint: 'Pick a poller-backed event (e.g. file.new, calendar.event.upcoming) to fire today, or wait for the connector validation before relying on this event.' });
        }
    }
    // A provider/event nothing on this install declares can never fire either,
    // but it stays a WARNING and is deliberately not completeness-listed:
    // declarations are per-install, and importing an automation onto a box that
    // does not have that integration yet must not be blocked — the automation
    // starts working the moment the integration is added.
    if (scope === 'root' && trigger.kind === 'app_event'
        && trigger.appEvent?.provider && trigger.appEvent?.event) {
        let known = null;
        try { known = require('../triggerSources').getTriggerSource(trigger.appEvent.provider); } catch { /* advisory only */ }
        if (known === null) {
            // Registry unavailable is indistinguishable from "not declared"
            // here, so only warn when we positively loaded a registry.
            let registryLoaded = false;
            try { registryLoaded = require('../triggerSources').listTriggerSources().length > 0; } catch { /* stay quiet */ }
            if (registryLoaded) {
                pushW({
                    code: 'trigger.app_event_unknown_provider', severity: 'warning',
                    path: p('trigger.appEvent.provider'),
                    message: `No integration on this install provides events for "${trigger.appEvent.provider}" — this trigger cannot fire.`,
                    hint: 'Install or enable the integration that owns this provider, or pick a different event source.',
                });
            }
        } else if (!(known.events || []).some(e => e.id === trigger.appEvent.event)) {
            const offered = (known.events || []).map(e => e.id);
            pushW({
                code: 'trigger.app_event_unknown_event', severity: 'warning',
                path: p('trigger.appEvent.event'),
                message: `"${trigger.appEvent.provider}" provides no event "${trigger.appEvent.event}" — this trigger cannot fire.`,
                hint: offered.length ? `Available: ${offered.slice(0, 8).join(', ')}${offered.length > 8 ? ', …' : ''}` : undefined,
            });
        }
    }
    // An app_event trigger with no provider/event can NEVER fire: the
    // subscription sync silently skips it, so the automation activated green and
    // then did nothing, with no diagnostic anywhere (C6). Completeness-listed:
    // a freshly-dropped trigger node has no appEvent yet and must stay
    // draft-saveable.
    if (!isContractScope && trigger.kind === 'app_event'
        && (!trigger.appEvent?.provider || !trigger.appEvent?.event)) {
        pushE({ code: 'trigger.app_event_incomplete', severity: 'error', path: p('trigger.appEvent'), message: 'App-event trigger has no provider/event — it can never fire.', hint: 'Open the trigger node and pick a provider and event.' });
    }

    // Additional triggers (definition.triggers[] — webhook/app_event only,
    // root scope only). `definition.trigger` stays the sole PRIMARY trigger;
    // this array holds EXTRA entry points, each still routed through
    // ordinary edges out of its own id (added to `ids` below so edge
    // references and topoOrder see it as another root — Kahn's algorithm
    // already seeds from every in-degree-0 node, not just one, so no cycle-
    // check changes are needed beyond including these ids in the graph).
    const ids = new Set([trigger.id]);
    const stepById = new Map();
    if (trigger.id) stepById.set(trigger.id, trigger);
    if (graph.triggers !== undefined) {
        if (isContractScope) {
            pushE({ code: 'triggers.not_supported_here', severity: 'error', path: p('triggers'), message: `A ${contractNoun} cannot declare additional triggers — only the automation root can.`, hint: 'Remove the `triggers` array from this scope.' });
        } else if (!Array.isArray(graph.triggers)) {
            pushE({ code: 'triggers.not_array', severity: 'error', path: p('triggers'), message: '`triggers` must be an array.', hint: 'Remove the field, or set it to an array of additional trigger step objects.' });
        } else {
            for (let i = 0; i < graph.triggers.length; i++) {
                const t = graph.triggers[i];
                // Path carries the trigger ID when present (not the index):
                // the FE maps validation records to canvas nodes by substring-
                // matching the id in `path`, so index-based paths left these
                // badges homeless (C7).
                const at = p(`triggers[${(isObject(t) && typeof t.id === 'string' && t.id) ? t.id : i}]`);
                if (!isObject(t)) { pushE({ code: 'triggers.item_shape', severity: 'error', path: at, message: 'Each additional trigger must be an object.', hint: 'Remove the malformed entry.' }); continue; }
                if (!t.id || typeof t.id !== 'string') { pushE({ code: 'triggers.item_id_missing', severity: 'error', path: at + '.id', message: 'Each additional trigger needs an `id`.', hint: 'Re-add it via the builder tool that generates a stable id.' }); continue; }
                if (ids.has(t.id)) { pushE({ code: 'triggers.item_id_duplicate', severity: 'error', path: at + '.id', message: `Duplicate step id: ${t.id}`, hint: 'Every trigger/step in the automation needs a unique id.' }); continue; }
                // Which kinds may be ADDITIONAL is one constant shared with the
                // builder tools (SECONDARY_TRIGGER_KINDS): webhook, app_event and
                // — since automation_schedules (2026-09) — schedule. manual /
                // form / agent_call / app_trigger only make sense as the one
                // primary entry.
                if (!SECONDARY_TRIGGER_KINDS.has(t.kind)) {
                    pushE({ code: 'triggers.kind_unsupported', severity: 'error', path: at + '.kind', message: `Additional trigger "${t.id}": kind must be one of ${[...SECONDARY_TRIGGER_KINDS].map(k => `"${k}"`).join(', ')} (got "${t.kind}").`, hint: 'Manual, form, agent-call and app triggers can only be the automation\'s one primary trigger.' });
                    continue;
                }
                // Same can-never-fire guard as the primary trigger (C6).
                if (t.kind === 'app_event' && (!t.appEvent?.provider || !t.appEvent?.event)) {
                    pushE({ code: 'trigger.app_event_incomplete', severity: 'error', path: at + '.appEvent', message: `Additional trigger "${t.id}": app-event trigger has no provider/event — it can never fire.`, hint: 'Open the trigger node and pick a provider and event.' });
                }
                // Same cron rules as the primary schedule — a secondary schedule
                // that cannot fire would sit "active" with next_run_at NULL.
                if (t.kind === 'schedule') checkScheduleTrigger(t, at, pushE);
                validatePosition(t.position, at, pushE);
                // Same pin rules as the primary trigger — an extra entry point
                // can be pinned too, and export strips both.
                checkPinnedOutput(t, at, { pushE, isTrigger: true });
                ids.add(t.id);
                stepById.set(t.id, t);
            }
        }
    }
    for (let i = 0; i < graph.steps.length; i++) {
        const s = graph.steps[i];
        const at = p(`steps[${i}]`);
        if (!isObject(s)) { pushE({ code: 'step.not_object', severity: 'error', path: at, message: 'Each step must be an object.', hint: 'Remove the malformed entry and add a fresh step via builder_add_*.' }); continue; }
        if (!s.id || typeof s.id !== 'string') { pushE({ code: 'step.id_missing', severity: 'error', path: at + '.id', message: 'Each step needs an `id`.', hint: 'Use the id returned from the previous builder_add_* tool result.' }); continue; }
        if (ids.has(s.id)) { pushE({ code: 'step.id_duplicate', severity: 'error', path: at + '.id', message: `Duplicate step id: ${s.id}`, hint: 'Remove the duplicate or call builder_remove_step on one of them.' }); continue; }
        if (!VALID_STEP_TYPES.has(s.type)) { pushE({ code: 'step.unknown_type', severity: 'error', path: at + '.type', message: `Step ${s.id}: unknown type "${s.type}".`, hint: `Use one of: ${[...VALID_STEP_TYPES].join(', ')}.` }); continue; }
        // Approval steps pause the run and resume by PARENT-graph step id —
        // a pause inside a layer/Step sub-graph has no resumable address. The
        // runner enforces this too (execApproval throws inside layers).
        if (isContractScope && s.type === 'approval') {
            pushE({ code: 'layer.approval_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: approval steps are not supported inside a ${contractNoun}.`, hint: `Move the approval to the parent flow, before or after the call to this ${contractNoun}.` });
            continue;
        }
        // A `return_to_app` ends the WHOLE run and hands its instructions to
        // the Studio App that started it. Inside a flowlet/Step there is no
        // such app to hand them to — a contract scope returns to its CALLER,
        // which is a step in another graph, not a screen. Same argument the
        // two rules around this one make: a sub-graph has no address for
        // something that happens outside it.
        if (isContractScope && s.type === 'return_to_app') {
            pushE({ code: 'layer.return_to_app_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: "Back to the app" steps are not supported inside a ${contractNoun}.`, hint: `A ${contractNoun} returns to whatever called it. Move the step to the automation's main flow, after the call to this ${contractNoun}.` });
            continue;
        }
        // Same reason for form pages, which pause identically.
        if (isContractScope && s.type === 'form_page') {
            pushE({ code: 'layer.form_page_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: form steps are not supported inside a ${contractNoun}.`, hint: `Move the form step to the parent flow, before or after the call to this ${contractNoun}.` });
            continue;
        }
        // v1: a Step cannot call another Step (cross-row recursion can't be
        // statically checked). Inline flowlets and nested-in-automation calls
        // remain fine; only scope='block' forbids it.
        if (scope === 'block' && s.type === 'call_block') {
            pushE({ code: 'block.nested_call_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: a Step cannot contain another Step (call_block) yet.`, hint: 'Inline the logic, or compose Steps at the automation level instead.' });
            continue;
        }
        validatePosition(s.position, at, pushE);
        checkBindableStepId(s, at, pushW);
        ids.add(s.id);
        stepById.set(s.id, s);
    }

    // Layer output contract: exactly one layer_output per layer. Zero is a
    // degenerate-but-runnable layer (returns the last step's output) →
    // warning; more than one is ambiguous → error. At the ROOT, layer_output
    // steps stay legal (orphan layers converted to automations keep theirs).
    if (isContractScope) {
        const outs = graph.steps.filter(s => isObject(s) && s.type === 'layer_output');
        if (outs.length === 0) {
            pushW({ code: 'layer.no_output', severity: 'warning', path: p('steps'), message: `${contractNoun} has no layer_output step — callers receive the last step\'s raw output.`, hint: 'Add a layer_output step with explicit fields so it has a stable output contract.' });
        } else if (outs.length > 1) {
            pushE({ code: 'layer.multiple_outputs', severity: 'error', path: p('steps'), message: `${contractNoun} has ${outs.length} layer_output steps — the output contract is ambiguous.`, hint: 'Keep exactly one layer_output step; merge the branches into it.' });
        }
    }

    // A Step whose body is CODE is a custom node, and it answers to a stricter
    // contract than the warning above (automation/customNode.js). The
    // difference is not pedantry: a layer without declared outputs still runs
    // and hands back its last step's raw output, but a custom node is picked
    // from a palette and bound to BY FIELD NAME — with nothing declared the
    // binding picker has no rows, every `steps.<id>.output.<field>` downstream
    // resolves to undefined, and the automation saves, runs green and writes
    // nothing. Its capability manifest is checked here too, because the reach
    // of a code body is a tool name inside a string and the graph cannot see
    // it; codeSandbox enforces exactly these names at run time, so a manifest
    // that disagrees with the body's allow-list is a promise nobody keeps.
    //
    // Only in a contract scope, and only when a code body is actually there:
    // a plain Step of ordinary steps is not a custom node and must keep the
    // warning it has always had, not inherit an error it never agreed to.
    if (scope === 'block') {
        const { isCustomNodeDefinition, validateCustomNode } = require('../customNode');
        if (isCustomNodeDefinition(graph)) {
            for (const issue of validateCustomNode(graph)) {
                pushE({
                    code: `custom_node.${issue.code}`,
                    severity: 'error',
                    path: issue.path ? p(issue.path) : p('steps'),
                    message: issue.message,
                    hint: issue.hint,
                });
            }
        }
    }

    // Edges — reference known nodes; labels are known + on_error sources legal.
    for (let i = 0; i < graph.edges.length; i++) {
        const e = graph.edges[i];
        const at = p(`edges[${i}]`);
        if (!isObject(e) || !e.from || !e.to) { pushE({ code: 'edge.shape', severity: 'error', path: at, message: 'Each edge needs `from` and `to`.', hint: 'Re-add the edge via the relevant builder_add_* tool which fills both fields.' }); continue; }
        if (!ids.has(e.from)) pushE({ code: 'edge.unknown_from', severity: 'error', path: at + '.from', message: `Edge from unknown node: ${e.from}`, hint: 'Either remove the edge or add the missing step.' });
        if (!ids.has(e.to))   pushE({ code: 'edge.unknown_to',   severity: 'error', path: at + '.to',   message: `Edge to unknown node: ${e.to}`,   hint: 'Either remove the edge or add the missing step.' });
        // A note (BFSF-411) is a canvas annotation, never a flow node — the
        // guarantee execution.js/execFlow.js build on is that it carries no
        // edges at all. Enforced here too (not just left to the canvas/builder
        // tools) so a hand-edited or AI-authored definition can never smuggle
        // one into the graph.
        if (ids.has(e.from) && stepById.get(e.from)?.type === 'note') {
            pushE({ code: 'edge.note_no_edges', severity: 'error', path: at + '.from', message: `Edge ${e.from} → ${e.to}: a note is a canvas annotation and cannot be wired into the flow.`, hint: 'Remove this edge — notes never connect to anything.' });
        }
        if (ids.has(e.to) && stepById.get(e.to)?.type === 'note') {
            pushE({ code: 'edge.note_no_edges', severity: 'error', path: at + '.to', message: `Edge ${e.from} → ${e.to}: a note is a canvas annotation and cannot be wired into the flow.`, hint: 'Remove this edge — notes never connect to anything.' });
        }
        if (typeof e.label === 'string' && e.label) {
            // 'case:<name>' labels are validated against the switch's case
            // names by the switch-step block below; everything else must be
            // one of the runner's routed labels or it never fires.
            if (!KNOWN_EDGE_LABELS.has(e.label) && !e.label.startsWith('case:')) {
                pushW({ code: 'edge.label_unknown', severity: 'warning', path: at + '.label', message: `Edge ${e.from} → ${e.to} has unknown label "${e.label}" — it will never fire.`, hint: 'Use one of: then, else, on_success, on_error, case:<switch-case-name>, or remove the label so the edge fires on success.' });
            }
            if (e.label === 'on_error' && ids.has(e.from)) {
                const srcType = e.from === trigger.id ? 'trigger' : stepById.get(e.from)?.type;
                if (ON_ERROR_FORBIDDEN_SOURCE_TYPES.has(srcType)) {
                    pushE({ code: 'edge.error_label_invalid', severity: 'error', path: at + '.label', message: `Edge ${e.from} → ${e.to}: a ${srcType === 'trigger' ? 'trigger' : `"${srcType}" step`} cannot have an on_error branch.`, hint: 'Error branches start from steps that can fail at run time (integration_action, ai_step, code, call_layer, loop, parallel, notification, wait). Remove this edge or move it to the failing step.' });
                } else if (!ON_ERROR_SOURCE_TYPES.has(srcType)) {
                    pushW({ code: 'edge.error_label_unlikely', severity: 'warning', path: at + '.label', message: `Edge ${e.from} → ${e.to}: "${srcType}" steps are pure data operations that rarely fail — this error branch will likely never run.`, hint: 'Error branches are meant for steps that talk to external systems (integration_action, ai_step, code, call_layer, …). Keep it only if you rely on a structured failure like collection_too_large.' });
                }
            }
        }
        // An UNLABELLED edge out of a brancher never fires: the runtime routes
        // every BRANCHER_TYPES step by branch label only. It draws from the
        // first port and looks like a working connection (B5). The canvas now
        // refuses to create these; JSON/AI authoring could still. Completeness-
        // listed: existing drafts keep saving, activation blocks.
        // guard is in the set for the same reason condition is — runDag routes
        // a guard by the SAME then/else labels — but it used to be omitted
        // here, so an unlabelled guard edge saved, activated and silently
        // never fired.
        if (!e.label && e.caseName == null && ids.has(e.from)) {
            const srcType = e.from === trigger.id ? 'trigger' : stepById.get(e.from)?.type;
            if (BRANCHER_TYPES.has(srcType)) {
                const hint = srcType === 'switch'
                    ? 'Delete it and drag from a case port (or the default port) instead.'
                    : srcType === 'guard'
                        ? 'Delete it and drag from the "personal data" or the "clean" port instead.'
                        : 'Delete it and drag from the then/else port instead.';
                pushE({ code: 'edge.branch_unlabelled', severity: 'error', path: at, message: `Edge ${e.from} → ${e.to} leaves a ${srcType} with no branch label — it will never fire.`, hint });
            }
        }
        // Anything after a TERMINAL step is dead by definition — the runner
        // ends its walk there (runDag.js), so an edge out of one is a line the
        // canvas draws and nothing ever follows. Driven off the one shared
        // TERMINAL_STEP_TYPES set so this rule and the runner cannot disagree
        // about which steps end a run; the severity comes from the per-type
        // table at the top of this file.
        if (ids.has(e.from) && TERMINAL_STEP_TYPES.has(stepById.get(e.from)?.type)) {
            const rule = TERMINAL_EDGE_RULES.get(stepById.get(e.from).type);
            // No table entry = a terminal soort nobody wrote a message for.
            // Report it anyway rather than let the edge through silently: an
            // unknown terminal narrows to "still terminal".
            const rec = rule
                ? { code: rule.code, severity: rule.severity, path: at, message: rule.message(e.from, e.to), hint: rule.hint }
                : { code: 'edge.after_terminal', severity: 'error', path: at, message: `Edge ${e.from} → ${e.to}: steps after a "${stepById.get(e.from).type}" step can never run.`, hint: 'That step ends the run. Remove this edge, or move the downstream steps before it.' };
            (rec.severity === 'warning' ? pushW : pushE)(rec);
        }
        // Cosmetic connection colour — a palette KEY, picked in the canvas
        // (list mirrors agent-hub .../Builder/flow/edgeColors.js). Unknown
        // values render as the default line colour, so a typo (AI/JSON
        // authoring) is a warning and never blocks a save.
        if (e.color !== undefined && !EDGE_COLOR_KEYS.has(e.color)) {
            pushW({ code: 'edge.color_unknown', severity: 'warning', path: at + '.color', message: `Edge ${e.from} → ${e.to} has unknown colour ${JSON.stringify(e.color)} — the builder will show the default line colour.`, hint: `Use one of: ${[...EDGE_COLOR_KEYS].join(', ')}, or remove the color field.` });
        }
    }
    // piiLineColors — the automation's PII group → colour overrides (Lines
    // panel). Same posture as edge.color: cosmetic, values must be palette
    // keys, anything else falls back to the default colour with a warning.
    if (graph.piiLineColors !== undefined) {
        if (!isObject(graph.piiLineColors)) {
            pushW({ code: 'piiLineColors.shape', severity: 'warning', path: p('piiLineColors'), message: 'piiLineColors must be an object of { <PII group>: <colour key> } — ignoring it.', hint: 'Set PII colours from the canvas: Lines → the rules panel.' });
        } else {
            for (const [group, key] of Object.entries(graph.piiLineColors)) {
                if (!EDGE_COLOR_KEYS.has(key)) {
                    pushW({ code: 'piiLineColors.color_unknown', severity: 'warning', path: p(`piiLineColors.${group}`), message: `PII line colour for "${group}" is ${JSON.stringify(key)} — not a palette key, the default colour will be used.`, hint: `Use one of: ${[...EDGE_COLOR_KEYS].join(', ')}, or remove the entry.` });
                }
            }
        }
    }
    if (errors.length > startErrors) return;

    // DAG check.
    const nodes = Array.from(ids);
    const order = topoOrder(nodes, graph.edges);
    if (!order) pushE({ code: 'graph.cycle', severity: 'error', path: p('edges'), message: 'Definition contains a cycle.', hint: 'Inspect the edges array; remove the back-edge that closes the loop.' });
    if (errors.length > startErrors) return;

    // call_layer reference checks — run over EVERY call step in this graph,
    // including those nested inside loop bodies / parallel branches.
    for (const { step, path: at } of collectCallLayerSteps(graph, pathPrefix)) {
        validateCallLayerStep(step, at, layers, pushE);
    }

    // call_block reference checks — external Step references. availableBlocks
    // (when provided) is the caller's published-Steps catalog.
    for (const { step, path: at } of collectCallBlockSteps(graph, pathPrefix)) {
        validateCallBlockStep(step, at, availableBlocks, pushE);
    }

    const seenSoFar = new Set([trigger.id]); // outputs available
    const checkStep = createStepChecker({
        graph, trigger, ids, seenSoFar, pushE, pushW,
        availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
    });

    // Nested walker — validates every step inside a loop body / parallel
    // branch with the SAME per-type rules as top-level steps, recursively.
    // The graph-size ceilings in validateDefinition already bound the total
    // node count, so recursion depth/width can't blow up here.
    //
    // `allKnownIds` spans top-level AND nested ids: at run time every body
    // step writes runState.steps[<id>] in its iteration's sub-state, so an id
    // collision silently clobbers real state (C3/C4).
    const allKnownIds = new Set(ids);
    // Known-id base for nested ref checks: all TOP-LEVEL ids plus the chain
    // of container/sibling ids accumulated on the way down.
    const refIdsFor = (chainIds) => new Set([...ids, ...chainIds]);
    const walkNested = (container, atContainer, chainIds, seenAtContainer) => {
        const groupsToWalk = container.type === 'loop'
            ? [{ items: Array.isArray(container.body) ? container.body : [], mkPath: (child) => `${atContainer}.body.steps[${child?.id ?? '?'}]`, missCode: 'loop.body_item_id_missing', typeCode: 'loop.body_item_type', where: 'loop body' }]
            : (Array.isArray(container.branches) ? container.branches : []).map((branch, bi) => ({
                items: Array.isArray(branch) ? branch : [],
                mkPath: (child) => `${atContainer}.branches[${bi}].steps[${child?.id ?? '?'}]`,
                missCode: 'parallel.branch_item_id_missing', typeCode: 'parallel.branch_item_type', where: `parallel branch ${bi}`,
            }));

        for (const group of groupsToWalk) {
            // Earlier siblings' outputs become available in document order —
            // the runtime chains the body linearly.
            const localSeen = new Set(seenAtContainer);
            for (const child of group.items) {
                if (!isObject(child) || !child.id) { pushE({ code: group.missCode, severity: 'error', path: atContainer, message: `Step ${container.id}: ${group.where} item missing id.`, hint: 'Re-add the nested step via the relevant builder_add_* tool.' }); continue; }
                const childAt = group.mkPath(child);
                if (!VALID_STEP_TYPES.has(child.type)) { pushE({ code: group.typeCode, severity: 'error', path: childAt, message: `Step ${container.id}: ${group.where} step "${child.id}" has unknown type "${child.type}".`, hint: `Use one of: ${[...VALID_STEP_TYPES].join(', ')}.` }); continue; }
                if (allKnownIds.has(child.id)) {
                    pushE({ code: 'loop.body_item_id_duplicate', severity: 'error', path: childAt + '.id', message: `Step ${container.id}: nested step id "${child.id}" collides with another step in this automation.`, hint: 'Every step id must be unique across the whole flow — nested steps write runState.steps[<id>] too, so a collision silently overwrites real data.' });
                    continue;
                }
                checkBindableStepId(child, childAt, pushW);
                allKnownIds.add(child.id);
                const childChain = new Set(chainIds);
                childChain.add(child.id);
                // call_layer / call_block children are validated by the
                // dedicated collect* passes above — running the generic rules
                // too would double-report them.
                if (child.type !== 'call_layer' && child.type !== 'call_block') {
                    // Known ids for refs: top-level ∪ container chain ∪ earlier
                    // siblings (localSeen) ∪ the child itself — a body step
                    // may read its predecessor in the same body.
                    checkStep(child, childAt, { nested: true, idsForRefs: new Set([...refIdsFor(childChain), ...localSeen]), seen: localSeen });
                }
                localSeen.add(child.id);
                if (child.type === 'loop' || child.type === 'parallel') {
                    walkNested(child, childAt, childChain, localSeen);
                }
            }
        }
    };
    for (const id of order) {
        const step = stepById.get(id);
        if (!step) continue;
        if (step.id === trigger.id) continue;
        const at = p(`steps[${id}]`);
        checkStep(step, at);
        if (step.type === 'loop' || step.type === 'parallel') {
            walkNested(step, at, new Set([step.id]), new Set([...seenSoFar, step.id]));
        }
        seenSoFar.add(step.id);
    }

    // An 'ending' page is the visitor's last screen. Asking another question
    // after it means they see "thanks, we're done" and are then handed a form —
    // almost always a wiring mistake, so warn rather than block.
    const endings = graph.steps.filter(s => isObject(s) && s.type === 'form_page' && s.mode === 'ending');
    if (endings.length) {
        const out = new Map();
        for (const e of (Array.isArray(graph.edges) ? graph.edges : [])) {
            if (!isObject(e) || !e.from) continue;
            if (!out.has(e.from)) out.set(e.from, []);
            out.get(e.from).push(e.to);
        }
        for (const end of endings) {
            const seen = new Set([end.id]);
            const queue = [...(out.get(end.id) || [])];
            while (queue.length) {
                const id = queue.shift();
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const node = stepById.get(id);
                if (isObject(node) && node.type === 'form_page' && node.mode !== 'ending') {
                    pushW({ code: 'form_page.input_after_ending', severity: 'warning', path: p(`steps[${node.id}]`), message: `Step ${node.id}: this form page asks a question after the closing page "${end.id}" has already been shown.`, hint: 'Move the closing page to the end of the flow.' });
                    continue;
                }
                queue.push(...(out.get(id) || []));
            }
        }
    }
}

module.exports = { validateGraph };

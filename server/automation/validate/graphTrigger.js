/**
 * The trigger rules of validateGraph (./graph.js): the primary trigger's id,
 * the contract-scope (layer/Step) trigger, the kind-specific contracts
 * (app_trigger, agent_call, form, schedule), and whether an app_event trigger
 * can be delivered on this install. checkScheduleTrigger also serves every
 * additional schedule trigger (./graphNodes.js).
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
const { isObject, validatePosition } = require('./helpers');

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

/** The kind-specific trigger contracts of a root (non-contract) graph. */
function checkTriggerKind({ trigger, p, pushE, pushW }) {
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
    // agent_call: the tool an agent sees (contract in
    // automation/agentCallContract.js). Shape problems block at every
    // stage. The description codes are only WARNINGS: the canvas stores a
    // blank description as null and the runtime then falls back on the
    // automation's description or title (automationToTool), and it cuts a
    // long one to the cap, so neither stops an automation that works today
    // from being saved, published or restored. A tool name without a
    // letter or digit and an argument name that is not an identifier are
    // completeness codes (completenessCodes.js).
    if (trigger.kind === 'agent_call') {
        const { validateAgentCallTrigger } = require('../agentCallContract');
        for (const issue of validateAgentCallTrigger(trigger)) {
            const rec = { code: `agent_call.${issue.code}`, severity: 'error', path: p(`trigger.${issue.path}`), message: issue.message, hint: issue.hint };
            if (issue.code === 'description_missing' || issue.code === 'description_invalid') pushW({ ...rec, severity: 'warning' });
            else pushE(rec);
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

/** Whether an app_event trigger has a delivery path and a declared provider/event (warnings only). */
function checkTriggerDeliverability({ trigger, scope, p, pushW }, deliverableEvents) {
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
            ? `Trigger event "${prov}.${ev}" has no producer (Nextcloud exposes no webhook for it and there is no poller) — it will activate but will never fire.`
            : `Trigger event "${prov}.${ev}" has no delivery path on this install — it will activate but may never fire.`;
        pushW({ code: 'trigger.app_event_undeliverable', severity: 'warning', path: p('trigger.appEvent.event'), message, hint: 'Pick a poller-backed event (e.g. file.new, calendar.event.upcoming) to fire today, or use a schedule trigger that reads the data with a tool.' });
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
}

/**
 * The primary trigger: its id, its kind (fixed layer_input in a contract
 * scope), position, pinned sample data and deliverability.
 */
function checkPrimaryTrigger(ctx, deliverableEvents) {
    const { graph, trigger, p, pushE, isContractScope, contractNoun, checkPinnedOutput } = ctx;
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
        checkTriggerKind(ctx);
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

    checkTriggerDeliverability(ctx, deliverableEvents);
    // An app_event trigger with no provider/event can NEVER fire: the
    // subscription sync silently skips it, so the automation activated green and
    // then did nothing, with no diagnostic anywhere (C6). Completeness-listed:
    // a freshly-dropped trigger node has no appEvent yet and must stay
    // draft-saveable.
    if (!isContractScope && trigger.kind === 'app_event'
        && (!trigger.appEvent?.provider || !trigger.appEvent?.event)) {
        pushE({ code: 'trigger.app_event_incomplete', severity: 'error', path: p('trigger.appEvent'), message: 'App-event trigger has no provider/event — it can never fire.', hint: 'Open the trigger node and pick a provider and event.' });
    }
}

module.exports = { checkPrimaryTrigger, checkScheduleTrigger };

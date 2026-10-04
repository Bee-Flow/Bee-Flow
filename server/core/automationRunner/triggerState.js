/**
 * The `trigger` slot of runState: the payload PLUS the facts about WHICH
 * trigger fired and HOW (multi-trigger automations, 2026-09).
 *
 * An automation may declare several entry points (`definition.trigger` +
 * `definition.triggers[]`). Until now a run could only see `trigger.output`,
 * so a step reachable from two roots had no way to tell a Gmail event from the
 * Monday-morning schedule. The metadata lives BESIDE `output`, never inside it:
 *
 *   - `output` stays the raw payload. The Privacy Shield scan rewrites
 *     `runState.trigger.output` and nothing else, so the meta is never
 *     tokenised, redacted or mistaken for user data.
 *   - A webhook body can therefore never collide with `kind`/`event`/…, and
 *     every existing `trigger.output.<field>` binding keeps its meaning.
 *
 * `kind` vs `source`: `kind` is what the DEFINITION says (the trigger node the
 * run entered through), `source` is how THIS run was actually started. A manual
 * test of the Gmail branch has kind 'app_event' and source 'manual'; an automation
 * branches on `kind`, and can tell a test run apart on `source`.
 *
 * Pure and dependency-free so tests (and the builder catalog) can use it without
 * the runner's database wiring.
 */

'use strict';

/** The keys a run can bind beside `trigger.output` — the picker lists these. */
const TRIGGER_META_KEYS = Object.freeze(['id', 'kind', 'source', 'label', 'provider', 'event', 'firedAt', 'schedule']);

function scheduleMeta(schedule, enteredTrigger) {
    if (schedule && typeof schedule === 'object') {
        return {
            cron: schedule.cron ?? null,
            tz: schedule.tz ?? null,
            scheduledFor: schedule.scheduledFor ? new Date(schedule.scheduledFor).toISOString() : null,
        };
    }
    const declared = enteredTrigger?.kind === 'schedule' ? enteredTrigger.schedule : null;
    if (!declared || typeof declared !== 'object') return null;
    return { cron: declared.cron ?? null, tz: declared.tz ?? null, scheduledFor: null };
}

/**
 * @param {object} opts
 * @param {object|null} opts.enteredTrigger  the trigger node the run entered through (resolveEnteredTrigger)
 * @param {string}      opts.triggerKind     how the run was dispatched: manual | manual_step | dry_run | schedule | app_event | webhook | form | agent_call | studio_app …
 * @param {*}           opts.triggerPayload  the raw payload (becomes `output`; `{}` when absent)
 * @param {object|null} opts.triggerHeaders  webhook/form headers (ride at `headers`, never inside output)
 * @param {object|null} opts.schedule        the secondary-schedule row that fired ({ id, cron, tz, scheduledFor }), if any
 * @param {number}      opts.startedAt       epoch ms the run started
 */
function buildTriggerState({
    enteredTrigger = null, triggerKind = 'manual', triggerPayload = null,
    triggerHeaders = null, schedule = null, startedAt = Date.now(),
} = {}) {
    const t = enteredTrigger && typeof enteredTrigger === 'object' ? enteredTrigger : null;
    const appEvent = t?.appEvent && typeof t.appEvent === 'object' ? t.appEvent : null;
    return {
        output: triggerPayload || {},
        ...(triggerHeaders ? { headers: triggerHeaders } : {}),
        id: t?.id ?? null,
        kind: t?.kind ?? null,
        source: triggerKind || null,
        label: typeof t?.label === 'string' ? t.label : null,
        provider: appEvent?.provider ?? null,
        event: appEvent?.event ?? null,
        firedAt: new Date(Number.isFinite(startedAt) ? startedAt : Date.now()).toISOString(),
        schedule: scheduleMeta(schedule, t),
    };
}

module.exports = { buildTriggerState, TRIGGER_META_KEYS };

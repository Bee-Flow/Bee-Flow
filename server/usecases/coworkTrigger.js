// @typecheck strict
/**
 * The event-trigger half of routes/cowork.js: an item that an agent starts on a
 * new mail (`triggerKind: 'app_event'`) instead of the clock. What it needs
 * before it is stored (a trigger that can work, an agent, a connected mailbox),
 * what an update does to the clock and trigger columns, and the subscription
 * that create / update / toggle / delete keep in step.
 */

const { HttpError } = require('../core/http/errors');
const coworkStore = require('../stores/coworkStore');
const { bestEffort } = require('../utils/bestEffort');
const { TRIGGER_TEXT, NEXT_RUN_TEXT } = require('./coworkTexts');

/**
 * The mail-trigger half of the item, required on first use (subscriptionSync
 * pulls in the trigger bus; the plain clock routes never need it).
 */
const mailTriggers = () => require('../automation/subscriptionSync');

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/coworkStore').getSchedule>>>} CoworkItem */
/** @typedef {{ provider: string, event: string, filter?: Record<string, unknown> | null }} MailTrigger */
/** @typedef {import('zod').infer<typeof import('../routes/coworkSchemas').UpdateBody>} UpdateInput */
/** @typedef {(agentId: string | null | undefined, userId: string, session: Express.Session) => Promise<string | null | undefined>} AgentResolver */

/**
 * Refuse a trigger that cannot work, before anything is stored: a mailbox that
 * does not parse (HttpError 400 invalid_mailbox), or a mail account that is not
 * connected (HttpError 409 mail_not_connected).
 * @param {string} userId
 * @param {{ provider: string, event: string, filter?: Record<string, unknown> | null }} trigger
 */
async function assertTriggerUsable(userId, trigger) {
    if (trigger.provider === 'msgraph' && trigger.filter && Object.hasOwn(trigger.filter, 'mailbox')) {
        require('../core/integrations/outlookMailbox.mts').parseMailbox(trigger.filter.mailbox);
    }
    await mailTriggers().assertMailTriggerReady(userId, trigger);
}

/**
 * The store's input for a new item. An event item has no clock (no nextRunAt).
 * @param {string} userId
 * @param {import('zod').infer<typeof import('../routes/coworkSchemas').CreateBody>} norm
 * @param {string | null | undefined} resolvedAgentId
 * @param {{ provider: string, event: string, filter?: Record<string, unknown> | null } | null} trigger
 */
function newItemFields(userId, norm, resolvedAgentId, trigger) {
    return {
        userId,
        title: norm.title,
        prompt: norm.prompt,
        repeatInterval: norm.repeatInterval ?? null,
        nextRunAt: trigger ? null : norm.nextRunAt,
        triggerKind: trigger ? 'app_event' : 'schedule',
        trigger,
        modelTier: norm.modelTier || 'fast',
        timezone: norm.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        agentId: resolvedAgentId ?? null,
        daysOfWeek: norm.daysOfWeek ?? null,
        timeOfDay: norm.timeOfDay ?? null,
        enabledApps: norm.enabledApps ?? null,
    };
}

/**
 * Give a new event item its subscription. No half-made item: one that could not
 * get its subscription would never fire, so it is removed again.
 * @param {CoworkItem} schedule
 */
async function syncNewEventItem(schedule) {
    try {
        await mailTriggers().syncCoworkMailTrigger(schedule);
    } catch (err) {
        await coworkStore.deleteSchedule(schedule.id).catch((e) => bestEffort('routes/cowork:create-rollback', e));
        throw err;
    }
}

/**
 * An event item needs a trigger and an agent (the agent_routines gate, also when
 * the agent itself is not part of this update), and, while it runs, a connected
 * mail account.
 * @param {{ existing: CoworkItem, body: UpdateInput, trigger: MailTrigger | null | undefined, resolvedAgentId: string | null | undefined, userId: string, session: Express.Session, resolveAgentId: AgentResolver }} a
 */
async function assertEventItemUsable({ existing, body, trigger, resolvedAgentId, userId, session, resolveAgentId }) {
    const effectiveAgent = resolvedAgentId !== undefined ? resolvedAgentId : existing.agentId;
    if (!trigger) throw new HttpError(400, 'trigger_required', 'An event-triggered item needs a trigger: ' + TRIGGER_TEXT);
    if (!effectiveAgent) throw new HttpError(400, 'agent_required', 'An event-triggered item runs an agent: agentId is required.');
    if (resolvedAgentId === undefined) await resolveAgentId(effectiveAgent, userId, session);
    if (body.isActive ?? existing.isActive) await assertTriggerUsable(userId, { ...trigger, filter: trigger.filter ?? null });
}

/**
 * What an update does to the trigger side of an item: the kind it ends up as,
 * the trigger, the clock and trigger columns to write, and whether the
 * subscription has to be re-synced (an event item has no clock; going
 * back to the clock needs a nextRunAt). Throws HttpError 400 for a combination
 * that cannot work and 409 when the mail account is not connected.
 * @param {{ existing: CoworkItem, body: UpdateInput, resolvedAgentId: string | null | undefined, userId: string, session: Express.Session, resolveAgentId: AgentResolver }} a
 */
async function planTriggerUpdate({ existing, body, resolvedAgentId, userId, session, resolveAgentId }) {
    const kind = body.triggerKind ?? existing.triggerKind;
    const isEvent = kind === 'app_event';
    const trigger = body.trigger !== undefined ? body.trigger : existing.trigger;
    if (!isEvent && body.trigger) throw new HttpError(400, 'trigger_kind_mismatch', "trigger only goes with triggerKind 'app_event'.");
    /** @type {Record<string, unknown>} */
    let eventFields = {};
    if (isEvent) {
        await assertEventItemUsable({ existing, body, trigger, resolvedAgentId, userId, session, resolveAgentId });
        // No clock: next_run_at NULL keeps the item out of the due-query.
        eventFields = { triggerKind: 'app_event', trigger, nextRunAt: null, repeatInterval: null, daysOfWeek: null, timeOfDay: null };
    } else if (existing.triggerKind === 'app_event') {
        if (!body.nextRunAt) throw new HttpError(400, 'next_run_at_required', NEXT_RUN_TEXT);
        eventFields = { triggerKind: 'schedule', trigger: null };
    }
    // An event item has no clock to write; a clock item writes what the body says.
    const clock = isEvent ? {} : { nextRunAt: body.nextRunAt, repeatInterval: body.repeatInterval, daysOfWeek: body.daysOfWeek, timeOfDay: body.timeOfDay };
    return { kind, trigger: isEvent ? trigger : null, patch: { ...clock, ...eventFields }, syncs: isEvent || existing.triggerKind === 'app_event' };
}

module.exports = { mailTriggers, assertTriggerUsable, newItemFields, syncNewEventItem, planTriggerUpdate };

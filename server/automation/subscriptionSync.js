/**
 * App-event subscription sync — one automation_event_subscriptions row per
 * app_event trigger (the primary `definition.trigger` AND every app_event
 * entry in `definition.triggers[]`), each tagged with its own triggerStepId
 * so dispatch.js seeds runDag from the trigger node that actually fired.
 *
 * Lived inside routes/automation/crud.js until 2026-09-04. It is shared now
 * because the MCP builder saves through builderTools/persistence.js, not
 * through PUT /:id — and an edit to an ACTIVE automation over MCP left the old
 * subscription (and its stale filter) in place until the next deactivate →
 * activate. Same code, same callers, one more entry point.
 */

const automationStore = require("../stores/automationStore");
const triggerBus = require("./triggerBus");
const log = require('../telemetry/log');

/**
 * Reconcile app_event subscriptions for one automation. Reads the trigger
 * from the persisted definition (not the row's `triggerType`/`scheduleCron`
 * shorthand fields) so a single source of truth covers provider, event,
 * and filter.
 *
 * Today only Gmail mail.new is supported end-to-end; other providers
 * (google-calendar / msgraph / github) have polling/webhook handlers but
 * we keep this helper provider-agnostic so adding them later is one
 * dispatch table change.
 */
/**
 * Revoke any remote (MS Graph) subscriptions for an automation BEFORE its
 * local subscription rows are deleted — otherwise we lose the externalRef and
 * leak orphaned subscriptions at the provider that keep firing into the void
 * until they expire. Best-effort: a revoke failure is logged, never fatal.
 */
async function revokeRemoteSubscriptions(automationId, userId) {
    try {
        const existing = await automationStore.getSubscriptionsForAutomation(automationId);
        const msgraphSubs = existing.filter(s => s.provider === 'msgraph' && s.externalRef);
        if (msgraphSubs.length > 0) {
            const session = await triggerBus.loadSession(userId).catch(() => null);
            for (const sub of msgraphSubs) {
                await triggerBus.revokeSubscription(sub, session);
            }
        }
    } catch (e) {
        log.warn(`[automation/subscriptionSync] revoke: revoke pass failed for ${automationId}: ${e.message}`);
    }
}

// True if the primary trigger OR any definition.triggers[] entry is app_event
// — the cheap gate PUT /:id uses to decide whether a re-sync is worth doing.
function hasAppEventTrigger(def) {
    return [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])]
        .some(t => t?.kind === 'app_event');
}

/**
 * Order-insensitive fingerprint of every app_event trigger's firing config.
 * Used by the PUT handler to skip subscription re-syncs for definition edits
 * that don't touch any app-event trigger (A12).
 */
function appEventFingerprint(def) {
    const trigs = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])]
        .filter(t => t && t.kind === 'app_event')
        .map(t => ({ id: t.id, provider: t.appEvent?.provider ?? null, event: t.appEvent?.event ?? null, filter: t.appEvent?.filter ?? null }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return JSON.stringify(trigs);
}

async function syncAppEventSubscription(automationId, userId, def) {
    // Snapshot the existing rows BEFORE the wipe so an unchanged trigger's
    // poller cursor can carry over (A12). The cursor is a provider-stream
    // position independent of the filter, so carrying it across a filter
    // change is correct — the interim events get delivered and re-filtered.
    // A genuinely NEW trigger still bootstraps with null (no history claim).
    let priorSubs = [];
    try { priorSubs = await automationStore.getSubscriptionsForAutomation(automationId) || []; }
    catch { /* fall back to fresh bootstrap */ }

    // Revoke any existing remote subscriptions BEFORE wiping the rows.
    await revokeRemoteSubscriptions(automationId, userId);
    await automationStore.deleteSubscriptionsForAutomation(automationId);

    // definition.trigger is the primary trigger; definition.triggers[] holds
    // additional webhook/app_event-only entries (scoped multi-trigger slice —
    // see automation/validate.js's `triggers[]` rules). Each app_event trigger
    // — primary or additional — gets its own subscription row, tagged with
    // triggerStepId so dispatch.js can seed runDag from the SPECIFIC node that
    // fired instead of always starting at the primary trigger.
    const appEventTriggers = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])]
        .filter(t => t && t.kind === 'app_event' && t.appEvent?.provider && t.appEvent?.event);
    for (const trig of appEventTriggers) {
        // Match the prior row for THIS trigger: by triggerStepId when the old
        // row carries one, else (legacy rows, all triggerStepId=null) by
        // provider+event.
        const prior = priorSubs.find(s => s.provider === trig.appEvent.provider
            && s.eventType === trig.appEvent.event
            && (s.triggerStepId ? s.triggerStepId === trig.id : true)) || null;
        await syncOneAppEventTrigger(automationId, userId, trig, prior);
    }
}

async function syncOneAppEventTrigger(automationId, userId, trig, prior = null) {
    const provider = trig.appEvent.provider;
    const event = trig.appEvent.event;

    // Mode resolution:
    //   - Gmail: polling (Pub/Sub push at /events/gmail exists but we don't
    //     auto-provision the watch yet).
    //   - MS Graph: webhook when PUBLIC_BASE_URL is set; falls back to
    //     polling-mode otherwise (which has no handler today, so the user
    //     gets a deactivated trigger — acceptable on local/dev installs).
    //   - GitHub: webhook (handled by /events/github inbound route).
    //   - Nextcloud: webhook when the user is connector-bound (the ExApp
    //     event-bridge pushes to /events/nextcloud); polling otherwise. The
    //     polling tick still runs as crash-recovery backstop when
    //     last_push_at goes stale.
    //   - Others: polling.
    let mode;
    if (provider === 'msgraph') {
        mode = triggerBus.getPublicBaseUrl() ? 'webhook' : 'polling';
    } else if (provider === 'github') {
        mode = 'webhook';
    } else if (provider === 'nextcloud') {
        // Per-event, not per-user. Events with a triggerBus poller MUST be
        // 'polling' regardless of hosting — otherwise calendar.event.upcoming /
        // file.new / activity.new never fire. Push-only events (share/deck/talk/
        // calendar mutations) are 'webhook' for connector-bound users (the ExApp
        // event-bridge delivers them) and 'polling' otherwise (no producer — the
        // poll tick simply no-ops, no handler error).
        //
        // (Fixes the prior `u?.ncUid` check: getUser returns the raw column
        // `nc_uid`, so ncUid was always undefined and every NC sub fell to
        // polling — which happened to be the only thing that worked.)
        const NC_POLLER_EVENTS = new Set([
            'file.new', 'file.changed', 'share.received',
            'activity.new', 'notification.new', 'calendar.event.upcoming',
        ]);
        if (NC_POLLER_EVENTS.has(event)) {
            mode = 'polling';
        } else {
            let isConnector = false;
            try {
                const userStore = require('../stores/userStore');
                const u = await userStore.getUser(userId).catch(() => null);
                isConnector = u?.provider === 'nextcloud_connector';
            } catch { /* default below */ }
            mode = isConnector ? 'webhook' : 'polling';
        }
    } else {
        // Declaration-driven providers say how they are produced; anything that
        // is not push-delivered gets polled, which is also the safe default for
        // a provider with no declaration at all.
        let declaredKind = null;
        try {
            declaredKind = require('./triggerSources').getEventDef(provider, event)?.source?.kind || null;
        } catch { /* fall through to polling */ }
        mode = declaredKind === 'push' ? 'webhook' : 'polling';
    }

    const sub = await automationStore.createSubscription({
        automationId,
        userId,
        provider,
        eventType: event,
        mode,
        filter: trig.appEvent?.filter || null,
        triggerStepId: trig.id,
        // Carry the poller cursor across a re-sync (A12): a null cursor makes
        // every poller re-anchor to "now" and silently skip everything since
        // the last poll. externalRef/clientState are NOT carried — MS Graph
        // provisioning below mints fresh ones.
        lastCursor: prior?.lastCursor ?? null,
    });

    // For MS Graph webhook subscriptions, register at MS Graph itself and
    // store the externalRef so the renewal pass can refresh and the
    // notification handler can validate clientState.
    if (provider === 'msgraph' && mode === 'webhook') {
        try {
            const session = await triggerBus.loadSession(userId).catch(() => null);
            const result = await triggerBus.provisionSubscription(sub, session);
            if (result) {
                await automationStore.updateSubscription(sub.id, {
                    externalRef: result.externalRef,
                    expiresAt: result.expiresAt,
                    clientState: result.clientState,
                });
            } else {
                // Provisioning failed — leave the row in the DB so the user
                // sees the trigger but warn so the diagnose endpoint can
                // surface it.
                log.warn(`[automation/subscriptionSync] MS Graph provisioning failed for sub ${sub.id}; trigger will not fire until re-activated`);
            }
        } catch (e) {
            log.warn(`[automation/subscriptionSync] MS Graph provisioning threw for sub ${sub.id}: ${e.message}`);
        }
    }
}

module.exports = { syncAppEventSubscription, revokeRemoteSubscriptions, hasAppEventTrigger, appEventFingerprint };

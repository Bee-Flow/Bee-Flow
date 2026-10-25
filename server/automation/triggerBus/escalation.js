// @typecheck
/**
 * Failure escalation for polling and MS Graph renewal, extracted verbatim from
 * ../triggerBus.js.
 *
 * `ctx` is the object triggerBus.js builds: `ctx.store()` (the current
 * automationStore, swappable through triggerBus._setDepsForTests) and
 * `ctx.notificationStore()` (required lazily, as it was inline), so this module
 * stays a leaf of the server's import cycle and its test needs no module mock.
 */

const log = require('../../telemetry/log');
const { fallback, bestEffort } = require('../../utils/bestEffort');

// ── Failure escalation ──────────────────────────────────
//
// Polling and renewal both used to silently skip on error. That hid token
// expiry and provider outages — users only noticed when they checked the
// run log and saw no activity. The escalation flow:
//
//   - Each fault increments consecutive_failures.
//   - On crossing the threshold we send ONE notification, recording
//     error_notified_at to debounce subsequent firings for 24h.
//   - Any successful poll/renew resets the counter and clears the timestamp.
//
// Polling threshold is 5 (≈5 minutes of bad polls) because providers can
// intermittently rate-limit. Renewal is 2 (≈2 minutes of bad PATCHes)
// because a missed renewal silently kills the subscription within the hour.

const POLL_FAILURE_THRESHOLD = 5;
const RENEW_FAILURE_THRESHOLD = 2;
const FAILURE_NOTIFY_DEBOUNCE_MS = 24 * 60 * 60_000;

async function escalateSubscriptionFailure(ctx, sub, threshold, errorMsg) {
    try {
        const { consecutiveFailures, errorNotifiedAt } = await ctx.store().incrementSubscriptionFailures(sub.id);
        if (consecutiveFailures < threshold) return;
        const lastNotified = errorNotifiedAt ? Date.parse(errorNotifiedAt) : 0;
        if (Number.isFinite(lastNotified) && Date.now() - lastNotified < FAILURE_NOTIFY_DEBOUNCE_MS) return;

        const automation = await ctx.store().getAutomation(sub.automationId).catch((e) => fallback('automation/triggerBus/escalation:escalateSubscriptionFailure', e, null));
        if (!automation) return;
        try {
            const notificationStore = ctx.notificationStore();
            await notificationStore.createNotification({
                userId: sub.userId,
                category: 'urgent',
                title: `⚠️ Trigger niet bereikbaar: ${automation.title}`,
                message: `Automation "${automation.title}" trigger (${sub.provider} ${sub.eventType}) faalt herhaaldelijk: ${errorMsg || 'onbekende fout'}. Controleer je integratie of activeer de automation opnieuw.`,
            });
        } catch (e) {
            log.warn(`[TriggerBus] notify failure for sub ${sub.id} failed: ${e.message}`);
        }
        await ctx.store().updateSubscription(sub.id, { errorNotifiedAt: new Date().toISOString() }).catch((e) => bestEffort('automation/triggerBus/escalation:escalateSubscriptionFailure#2', e));
    } catch (e) {
        log.warn(`[TriggerBus] escalateSubscriptionFailure error: ${e.message}`);
    }
}

module.exports = { POLL_FAILURE_THRESHOLD, RENEW_FAILURE_THRESHOLD, FAILURE_NOTIFY_DEBOUNCE_MS, escalateSubscriptionFailure };

/**
 * One automation_event_subscriptions row as the store maps it.
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/automationStore').getSubscription>>>} TriggerSubscription
 */

/**
 * The credentials a poller or renewal pass runs with (triggerBus.loadSession).
 * @typedef {Object} TriggerSession
 * @property {string} [accessToken]
 * @property {string | null} [refreshToken]
 * @property {string | null} [oauthProvider]
 * @property {Record<string, Record<string, unknown>>} [automationProviders]
 * @property {string} [_source]  'vault' | 'connector' | 'session'
 * @property {string | null} [connectorOrgId]
 * @property {string | null} [connectorNcUid]
 * @property {{ id: string, provider: string, organizationId: string | null, ncUid: string | null }} [user]
 */

/**
 * A googleapis client as createGoogleApiClient returns it.
 * @typedef {Awaited<ReturnType<typeof import('../../integrations/googleClient').createGoogleApiClient>>} GoogleApiClient
 */

/**
 * One poll of one subscription: the payloads to dispatch.
 * @typedef {(sub: TriggerSubscription, session: TriggerSession | null) => Promise<Record<string, any>[]>} PollerFn
 */

/**
 * What triggerBus.js hands to the extracted pollers, escalation and renewal.
 * @typedef {Object} TriggerBusCtx
 * @property {() => typeof import('../../stores/automationStore')} store
 * @property {() => typeof import('../../integrations/googleClient')} googleClient
 * @property {() => typeof import('../../integrations/gmailTools')} gmailTools
 * @property {() => typeof import('../../integrations/nextcloudActivityTools')} nextcloudActivityTools
 * @property {() => typeof import('../../integrations/nextcloudNotificationsTools')} nextcloudNotificationsTools
 * @property {() => typeof import('../../integrations/nextcloudCalendarTools')} nextcloudCalendarTools
 * @property {() => typeof import('../../core/integrations/ncScopeGuard')} ncScopeGuard
 * @property {() => typeof import('../../stores/notificationStore')} notificationStore
 * @property {(userId: string) => Promise<TriggerSession | null>} loadSession
 * @property {(sub: TriggerSubscription, threshold: number, errorMsg?: string) => Promise<void>} escalate
 */

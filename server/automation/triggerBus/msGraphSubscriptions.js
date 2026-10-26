// @typecheck
/**
 * MS Graph subscriptions: provision on activate, revoke on deactivate, renew
 * before expiry. Extracted verbatim from ../triggerBus.js.
 *
 * Only the renewal pass takes `ctx` (the object triggerBus.js builds: the
 * current automationStore, loadSession and the failure escalation), so this
 * module stays a leaf of the server's import cycle.
 */

const log = require('../../telemetry/log');
const { RENEW_FAILURE_THRESHOLD } = require('./escalation');

// ── MS Graph subscription provisioning ──────────────────
//
// Until now the inbound `/events/msgraph` route existed but no code created
// the corresponding subscriptions at MS Graph itself, so events never
// arrived. provisionSubscription POSTs to /v1.0/subscriptions on activate;
// revokeSubscription DELETEs it on deactivate so we don't leak orphan
// subscriptions when an automation is paused or removed.
//
// Both helpers are best-effort: a provisioning failure is logged and the
// row is left without an externalRef so the caller can fall back to polling
// (or, if the eventType has no polling handler, raise it as an activation
// warning). Throws are converted to return values to keep callers simple.

/** @type {Record<string, { resource: string; changeType: string; }>} */
const MSGRAPH_RESOURCE_MAP = {
    'mail.new':       { resource: "me/mailFolders('Inbox')/messages", changeType: 'created' },
    'mail.flagged':   { resource: "me/mailFolders('Inbox')/messages", changeType: 'updated' },
    'event.created':  { resource: 'me/events',                        changeType: 'created' },
    'event.updated':  { resource: 'me/events',                        changeType: 'updated' },
    'event.changed':  { resource: 'me/events',                        changeType: 'updated' },
    'file.changed':   { resource: 'me/drive/root',                    changeType: 'updated' },
    'file.new':       { resource: 'me/drive/root',                    changeType: 'created' },
};

// MS Graph subscriptions live for at most ~71h for mail/events and 2h for
// drive resources. Renewing every 50 minutes keeps the renewal pass simple
// and works for every resource type.
const MSGRAPH_LIFETIME_MS = 50 * 60_000;

// Promoted to automation/publicUrl.js so the webhook routes can share it
// (BFSF-320). Re-exported here under the original name — every existing caller
// in this file is untouched.
const { getPublicBaseUrl } = require('../publicUrl');

/**
 * The Microsoft bearer token of a trigger session. loadSession's primary is
 * whichever provider came first (Gmail before Outlook), so a user with Google
 * AND Microsoft had their Google token sent to Graph, and every subscribe and
 * renew failed with 401. The Microsoft credential sits under
 * automationProviders.microsoft then.
 * @param {{ oauthProvider?: string | null, accessToken?: string | null,
 *   automationProviders?: { microsoft?: { accessToken?: string | null } | null } | null } | null | undefined} session
 * @returns {string | null}
 */
function microsoftTokenOf(session) {
    if (session?.oauthProvider === 'microsoft' && session?.accessToken) return session.accessToken;
    if (session?.automationProviders?.microsoft?.accessToken) return session.automationProviders.microsoft.accessToken;
    // A session that names no provider at all is taken as it is (older callers and tests).
    if (!session?.oauthProvider && session?.accessToken) return session.accessToken;
    return null;
}

/**
 * Is this row a shared mailbox's? Those are never subscribed at Graph (it
 * refuses change notifications on shared mailboxes for delegated access);
 * they are polled (pollers/msGraphMail.mts).
 * @param {{ eventType?: string, filter?: Record<string, unknown> | null }} sub
 */
function isSharedMailboxSub(sub) {
    const mailbox = sub?.filter?.mailbox;
    if (mailbox === undefined || mailbox === null || !String(sub?.eventType || '').startsWith('mail.')) return false;
    const { parseMailbox } = require('../../core/integrations/outlookMailbox.mts');
    try { return parseMailbox(mailbox).shared; } catch { return true; }
}

function buildClientState(userId, automationId) {
    const secret = process.env.MSGRAPH_CLIENT_STATE_SECRET || process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error('MSGRAPH_CLIENT_STATE_SECRET or SESSION_SECRET must be set (≥32 chars) for OAuth-state CSRF protection.');
    }
    return require('crypto')
        .createHmac('sha256', secret)
        .update(`${userId}|${automationId}`)
        .digest('hex');
}

/**
 * Provision an MS Graph subscription for a webhook-mode subscription row.
 * Returns `{ externalRef, expiresAt, clientState }` on success, or null on
 * failure (caller should log and proceed without webhook delivery).
 *
 * Skipped (returns null) when no PUBLIC_BASE_URL is configured — without a
 * publicly-reachable HTTPS endpoint MS Graph cannot validate the
 * notificationUrl and the POST would fail with 400.
 */
async function provisionSubscription(sub, session) {
    if (sub.provider !== 'msgraph') return null;
    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
        log.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — PUBLIC_BASE_URL not set`);
        return null;
    }
    if (isSharedMailboxSub(sub)) {
        log.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — a shared mailbox is polled, not subscribed`);
        return null;
    }
    const token = microsoftTokenOf(session);
    if (!token) {
        log.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — no access token`);
        return null;
    }
    const map = MSGRAPH_RESOURCE_MAP[sub.eventType];
    if (!map) {
        log.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — unsupported eventType ${sub.eventType}`);
        return null;
    }
    const expiresAt = new Date(Date.now() + MSGRAPH_LIFETIME_MS).toISOString();
    const clientState = buildClientState(sub.userId, sub.automationId);
    const body = {
        changeType: map.changeType,
        notificationUrl: `${baseUrl.replace(/\/+$/, '')}/api/automation/events/msgraph`,
        resource: map.resource,
        expirationDateTime: expiresAt,
        clientState,
    };
    try {
        const r = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            log.warn(`[TriggerBus] MS Graph subscribe failed for ${sub.id}: ${r.status} ${text.slice(0, 200)}`);
            return null;
        }
        const data = /** @type {any} */ (await r.json().catch(() => ({})));
        if (!data?.id) {
            log.warn(`[TriggerBus] MS Graph subscribe returned no id for ${sub.id}`);
            return null;
        }
        return { externalRef: data.id, expiresAt: data.expirationDateTime || expiresAt, clientState };
    } catch (e) {
        log.warn(`[TriggerBus] MS Graph subscribe threw for ${sub.id}: ${/** @type {Error} */ (e).message}`);
        return null;
    }
}

/**
 * Best-effort revoke. We don't surface failures to the caller because
 * deactivation must succeed even if MS Graph rejects the DELETE — the next
 * renewal tick will simply not refresh the subscription, and it expires
 * naturally within ~50min.
 */
async function revokeSubscription(sub, session) {
    if (sub.provider !== 'msgraph') return false;
    if (!sub.externalRef) return false;
    const token = microsoftTokenOf(session);
    if (!token) return false;
    try {
        const r = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.externalRef}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        // 404 = already gone, treat as success.
        return r.ok || r.status === 404;
    } catch (e) {
        log.warn(`[TriggerBus] MS Graph unsubscribe threw for ${sub.id}: ${/** @type {Error} */ (e).message}`);
        return false;
    }
}

// ── Subscription renewal (MS Graph) ─────────────────────

async function renewExpiringSubscriptions(ctx) {
    try {
        const subs = await ctx.store().getExpiringSubscriptions({ withinMs: 5 * 60_000 });
        for (const sub of subs) {
            if (sub.provider !== 'msgraph') continue;
            // Never renewed at Graph: a shared mailbox has no Graph subscription.
            if (isSharedMailboxSub(sub)) continue;
            try {
                const session = await ctx.loadSession(sub.userId);
                const token = microsoftTokenOf(session);
                if (!token) {
                    await ctx.escalate(sub, RENEW_FAILURE_THRESHOLD, 'no access token');
                    continue;
                }
                const newExpiry = new Date(Date.now() + MSGRAPH_LIFETIME_MS).toISOString();
                const r = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.externalRef}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expirationDateTime: newExpiry }),
                });
                if (!r.ok) {
                    const text = await r.text().catch(() => '');
                    log.warn(`[TriggerBus] msgraph sub renewal failed: ${r.status} ${text.slice(0, 200)}`);
                    await ctx.escalate(sub, RENEW_FAILURE_THRESHOLD, `${r.status}`);
                    continue;
                }
                await ctx.store().updateSubscription(sub.id, { expiresAt: newExpiry });
                await ctx.store().resetSubscriptionFailures(sub.id);
            } catch (e) {
                log.warn(`[TriggerBus] msgraph sub renewal failed: ${/** @type {Error} */ (e).message}`);
                await ctx.escalate(sub, RENEW_FAILURE_THRESHOLD, /** @type {Error} */ (e).message);
            }
        }
    } catch (e) {
        log.warn('[TriggerBus] renewal pass error:', /** @type {Error} */ (e).message);
    }
}

module.exports = {
    MSGRAPH_RESOURCE_MAP,
    MSGRAPH_LIFETIME_MS,
    getPublicBaseUrl,
    buildClientState,
    microsoftTokenOf,
    isSharedMailboxSub,
    provisionSubscription,
    revokeSubscription,
    renewExpiringSubscriptions,
};

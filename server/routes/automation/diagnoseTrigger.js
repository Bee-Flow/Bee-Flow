/**
 * POST /:id/diagnose-trigger: the trigger pipeline health check, split out of
 * routes/automation/runs.js (which mounts this router in its old place, so the
 * route table keeps its order). Needs `edit`: it reports on the owner's
 * connected accounts and subscriptions.
 */

'use strict';

const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const { getDeliverableEvents, isPushPending } = require('../../automation/deliverableEvents');
const { makeAutomationAccess } = require('../../automation/access');
const automationAccess = makeAutomationAccess({ store: automationStore });

/**
 * Run a one-shot health check on the trigger pipeline for one automation.
 *
 * Without this endpoint, "the trigger doesn't fire" produces no actionable
 * feedback for the user — the polling tick is silent unless something
 * succeeds. This endpoint walks every link in the chain (subscription row →
 * vault credentials → live Gmail call → filter match) and returns a
 * structured result the UI can render.
 *
 * Tokens are NEVER returned — only booleans and high-level shape.
 */
router.post('/:id/diagnose-trigger', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    // The trigger listens on the OWNER's account, so that is what is diagnosed.
    // The caller's session only stands in when the caller is the owner.
    const userId = a.userId || req.session.user.id;
    const ownSession = userId === req.session.user.id ? req.session : null;

    const trig = a.definition?.trigger;
    const provider = trig?.appEvent?.provider;
    const event = trig?.appEvent?.event;

    // ── Nextcloud diagnostics ─────────────────────────────────────────
    // READ-ONLY / observational. Reports the state of the trigger so the
    // user can see why a routine is (or isn't) firing. It does NOT change
    // how Nextcloud connects or how auth is resolved. Mirrors the Gmail
    // check shape so the generic TriggerDiagnosePanel renders it unchanged.
    if (trig?.kind === 'app_event' && provider === 'nextcloud') {
        const checks = [];
        const finish = (ok) => res.json({ ok, kind: `nextcloud.${event}`, checks });
        const ncAppIdForEvent = (ev) => {
            if (!ev) return 'nextcloud';
            if (ev.startsWith('calendar.')) return 'nextcloud-calendar';
            if (ev.startsWith('deck.')) return 'nextcloud-deck';
            if (ev.startsWith('talk.')) return 'nextcloud-talk';
            if (ev.startsWith('task.')) return 'nextcloud-tasks';
            if (ev === 'notification.new') return 'nextcloud-notifications';
            if (ev === 'activity.new') return 'nextcloud-activity';
            if (ev.startsWith('user.status')) return 'nextcloud-status';
            return 'nextcloud';
        };

        // 1) Integration enabled for this user/org
        try {
            const apps = await require('../../core/integrations/integrationTools').getUserPermittedApps({
                userId, session: ownSession,
                isAdmin: !!ownSession && (!!ownSession.isAdmin || ownSession.user?.role === 'admin'),
            });
            const appId = ncAppIdForEvent(event);
            checks.push(apps.has(appId)
                ? { name: 'integration_enabled', status: 'ok', message: `${appId} is enabled.` }
                : { name: 'integration_enabled', status: 'error', message: `${appId} is not enabled for your account.`, detail: { remediation: 'Ask your org admin to enable this Nextcloud app.' } });
        } catch (e) {
            checks.push({ name: 'integration_enabled', status: 'warn', message: `Could not resolve permitted apps: ${e.message}` });
        }

        // 2) Auth mode (observational — reports how NC tools authenticate)
        let session = null;
        try { session = await require('../../automation/triggerBus').loadSession(userId); } catch { session = null; }
        const isConnector = !!(session && (session._source === 'connector' || session.connectorOrgId || session.user?.provider === 'nextcloud_connector'));
        if (isConnector) {
            checks.push({ name: 'auth_mode', status: 'ok', message: 'Connector identity present — NC tools route via the Bee Flow ExApp proxy.', detail: { source: session._source || 'connector' } });
        } else if (session && require('../../integrations/nextcloudClient').isNextcloudOAuthSession(session)) {
            checks.push({ name: 'auth_mode', status: 'ok', message: 'Nextcloud OAuth session found (bearer token).', detail: { source: session._source || 'oauth' } });
        } else if (session?.accessToken) {
            checks.push({ name: 'auth_mode', status: 'ok', message: 'Nextcloud session found.', detail: { source: session._source || 'session' } });
        } else {
            checks.push({ name: 'auth_mode', status: 'error', message: 'No Nextcloud credentials found for scheduled/offline runs.', detail: { remediation: 'Connect Nextcloud in Settings → Integrations.' } });
        }

        // 3) Subscription state (cursor / lastPolledAt / lastPushAt / failures)
        const subs = await automationStore.getSubscriptionsForAutomation(a.id);
        const sub = subs.find(s => s.provider === 'nextcloud' && s.eventType === event) || null;
        if (!sub) {
            checks.push({ name: 'subscription', status: 'error', message: 'No subscription yet — click Activate to create it.' });
        } else {
            const failing = (sub.consecutiveFailures || 0) > 0;
            checks.push({
                name: 'subscription',
                status: failing ? 'warn' : 'ok',
                message: failing ? `Subscription ${sub.id} has ${sub.consecutiveFailures} recent failure(s).` : `Subscription ${sub.id} active (mode=${sub.mode}).`,
                detail: { mode: sub.mode, modePreference: sub.modePreference, lastCursor: sub.lastCursor, lastPolledAt: sub.lastPolledAt, lastPushAt: sub.lastPushAt, consecutiveFailures: sub.consecutiveFailures },
            });
        }

        // 4) Deliverability — poller-backed fires today; push-only needs the
        // (deferred) Bee Flow ExApp connector push pipeline.
        const pollerBacked = getDeliverableEvents().nextcloud.has(event);
        if (pollerBacked) {
            checks.push({ name: 'deliverability', status: 'ok', message: 'Poller-backed — fires on the poll tick with no connector dependency.' });
        } else if (isPushPending('nextcloud', event)) {
            checks.push({ name: 'deliverability', status: 'warn', message: 'This event requires the Bee Flow ExApp connector and is pending live validation.' });
        } else {
            checks.push({ name: 'deliverability', status: 'warn', message: 'No producer for this event yet — it will not fire until a poller or the connector delivers it.' });
        }

        // 5) Recent-match probe — only meaningful for poller-backed events
        if (pollerBacked) {
            try {
                const match = await require('../../automation/triggerBus').fetchLatestNextcloudMatch(userId, event, trig.appEvent.filter || null);
                checks.push(match
                    ? { name: 'recent_match', status: 'ok', message: 'Found a recent matching item — the trigger has data to fire on.', detail: match }
                    : { name: 'recent_match', status: 'warn', message: 'No recent matching activity — the trigger fires when a match arrives.' });
            } catch (e) {
                const { classifyNextcloudError } = require('../../core/integrations/nextcloudErrorClassifier');
                const c = classifyNextcloudError(e);
                checks.push({ name: 'recent_match', status: 'warn', message: c.message, detail: { remediation: c.remediation } });
            }
        }

        return finish(checks.every(c => c.status !== 'error'));
    }

    if (trig?.kind !== 'app_event' || provider !== 'gmail' || event !== 'mail.new') {
        return res.json({
            ok: true,
            kind: trig?.kind || 'unknown',
            checks: [{ name: 'trigger_type', status: 'skipped', message: 'This automation is not Gmail-triggered; nothing to diagnose.' }],
        });
    }

    const checks = [];
    const finish = (ok) => res.json({ ok, kind: 'gmail.mail.new', checks });

    // 1) Subscription row
    const subs = await automationStore.getSubscriptionsForAutomation(a.id);
    const sub = subs.find(s => s.provider === 'gmail' && s.eventType === 'mail.new') || null;
    if (!sub) {
        checks.push({
            name: 'subscription',
            status: 'error',
            message: 'No automation_event_subscriptions row exists. Click Activate to create one.',
        });
        return finish(false);
    }
    checks.push({
        name: 'subscription',
        status: 'ok',
        message: `Subscription ${sub.id} found (mode=${sub.mode}).`,
        detail: {
            lastCursor: sub.lastCursor,
            lastPolledAt: sub.lastPolledAt,
            filter: sub.filter,
        },
    });

    // 2) Credentials. Use the same loadSession the polling pass uses —
    // tries the vault first, then falls back to user_sessions (where
    // the chat-side OAuth flow puts tokens for users who connected
    // before the vault existed). Reporting the source helps the user
    // understand whether they're on a stable long-lived vault entry or
    // depending on their browser session staying alive.
    let session = null;
    try {
        const triggerBus = require('../../automation/triggerBus');
        session = await triggerBus.loadSession(userId);
    } catch (e) {
        checks.push({ name: 'credentials', status: 'error', message: `Credential lookup threw: ${e.message}` });
        return finish(false);
    }
    if (!session?.accessToken) {
        checks.push({
            name: 'credentials',
            status: 'error',
            message: 'No Gmail OAuth tokens found in either the routine vault or the active browser session. Sign in to Bee Flow and re-connect Gmail in Integrations.',
        });
        return finish(false);
    }
    checks.push({
        name: 'credentials',
        status: session._source === 'vault' ? 'ok' : 'warn',
        message: session._source === 'vault'
            ? `Gmail tokens loaded from the routine vault (long-lived, auto-refresh).`
            : `Gmail tokens loaded from your browser session. The trigger will keep firing while you stay signed in; re-connect Gmail in Integrations to upgrade to a long-lived vault entry.`,
        detail: { source: session._source, hasAccessToken: true, hasRefreshToken: !!session.refreshToken, oauthProvider: session.oauthProvider || null },
    });

    // 3) Live Gmail history call (or bootstrap)
    try {
        const { createGoogleApiClient } = require('../../integrations/googleClient');
        const gmail = await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });
        if (sub.lastCursor) {
            try {
                const r = await gmail.users.history.list({
                    userId: 'me',
                    startHistoryId: sub.lastCursor,
                    historyTypes: ['messageAdded'],
                });
                const count = (r.data.history || []).reduce((acc, h) => acc + (h.messagesAdded?.length || 0), 0);
                checks.push({
                    name: 'gmail_history',
                    status: 'ok',
                    message: `history.list succeeded; ${count} new message(s) since cursor.`,
                    detail: { newCount: count, currentHistoryId: r.data.historyId || null },
                });
            } catch (err) {
                const stale = err.code === 404 || /not found|invalid history id/i.test(err.message || '');
                checks.push({
                    name: 'gmail_history',
                    status: stale ? 'warn' : 'error',
                    message: stale
                        ? `Cursor ${sub.lastCursor} is stale (Gmail returned: ${err.message}). The poller will reset it on the next tick.`
                        : `gmail.users.history.list failed: ${err.message}`,
                });
            }
        } else {
            const profile = await gmail.users.getProfile({ userId: 'me' });
            checks.push({
                name: 'gmail_history',
                status: 'warn',
                message: 'No cursor yet — bootstrap needed. The next poll tick will anchor the cursor.',
                detail: { profileHistoryId: profile.data.historyId || null },
            });
        }
    } catch (e) {
        checks.push({ name: 'gmail_history', status: 'error', message: `Gmail API not reachable: ${e.message}` });
        return finish(false);
    }

    // 4) Latest matching message — same lookup the manual run uses
    try {
        const triggerBus = require('../../automation/triggerBus');
        const latest = await triggerBus.fetchLatestGmailMatch(userId, trig.appEvent.filter || null);
        if (!latest) {
            checks.push({
                name: 'recent_match',
                status: 'warn',
                message: 'No recent inbox messages match the filter. The trigger will fire as soon as a matching email arrives.',
            });
        } else {
            checks.push({
                name: 'recent_match',
                status: 'ok',
                message: `Most recent matching email: "${latest.subject}" from ${latest.from}.`,
                detail: { subject: latest.subject, from: latest.from, date: latest.date, labelIds: latest.labelIds },
            });
        }
    } catch (e) {
        checks.push({ name: 'recent_match', status: 'error', message: `Filter probe failed: ${e.message}` });
    }

    return finish(checks.every(c => c.status !== 'error'));
});

module.exports = router;

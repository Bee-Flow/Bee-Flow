/** @typedef {import('../core/automationModel/dslFilters').DslFilter} DslFilter */
// @typecheck
/**
 * Trigger Bus — fans incoming app events into matching automation runs.
 *
 * dispatchEvent({ provider, event, payload, userId? })
 *   - finds matching automation_event_subscriptions rows
 *   - applies any per-subscription filter
 *   - calls automationRunner.executeAutomation(...) for each match
 *
 * Also owns:
 *   - runPollingPass()             : polling-mode subscriptions
 *   - renewExpiringSubscriptions() : MS Graph subscription refresh
 *
 * The hand-written pollers live in ./triggerBus/pollers/ (gmail,
 * googleCalendar, googleDrive, nextcloud), the MS Graph subscription
 * lifecycle in ./triggerBus/msGraphSubscriptions.js, failure escalation in
 * ./triggerBus/escalation.js and the latest-match lookups in
 * ./triggerBus/latestMatch.js. This file keeps the polling pass, the
 * declaration-driven source runner, loadSession and the shared state those
 * modules read through `ctx` (below).
 */

const REAL_AUTOMATION_STORE = require('../stores/automationStore');
// `let` only for _setDepsForTests (bottom of this file); production never reassigns it.
let automationStore = REAL_AUTOMATION_STORE;
const { applyDslFilter } = require('./triggers/dslFilters');

// §WS5 — matchers + dispatch live in ./triggerBus/{filters,dispatch}.js.
const { matchGmailMailFilter, matchGmailLabelFilter, matchCalendarChangedFilter, matchCalendarUpcomingFilter, matchDriveFileNewFilter, matchNextcloudFileFilter, matchNextcloudShareFilter, matchNextcloudShareGenericFilter, matchNextcloudActivityFilter, matchNextcloudNotificationFilter, matchNextcloudCommentFilter, matchNextcloudTagFilter, matchSupportTicketResolvedFilter, matchNextcloudCalendarFilter, matchNextcloudCalendarUpcomingFilter, matchNextcloudDeckCardFilter, matchNextcloudDeckCardMovedFilter, matchNextcloudTalkMessageFilter, matchNextcloudTaskFilter, matchNextcloudUserStatusFilter } = require('./triggerBus/filters');
const { dispatchEvent, dispatchToSubscription, dispatchSupportEvent } = require('./triggerBus/dispatch');
const { makePassCtx } = require('./triggerSources/pollDiff');
const log = require('../telemetry/log');
const { createGmailPollers } = require('./triggerBus/pollers/gmail');
const { createGoogleCalendarPollers } = require('./triggerBus/pollers/googleCalendar');
const { createGoogleDrivePollers } = require('./triggerBus/pollers/googleDrive');
const { createNextcloudPollers, _ncNormaliseActivity } = require('./triggerBus/pollers/nextcloud');
const { withNcVisibility } = require('./triggerBus/ncVisibilityWiring');
const { POLL_FAILURE_THRESHOLD, escalateSubscriptionFailure: escalateWithCtx } = require('./triggerBus/escalation');
const { getPublicBaseUrl, buildClientState, provisionSubscription, revokeSubscription, renewExpiringSubscriptions: renewWithCtx } = require('./triggerBus/msGraphSubscriptions');
const latestMatch = require('./triggerBus/latestMatch');
const { fallback } = require('../utils/bestEffort');

// Test seam (_setDepsForTests): the credential lookups, the Google client
// factory and the per-subscription dispatcher the polling pass goes through,
// so a test drives runPollingPass against fakes without touching the module
// cache. Modules stay lazily required, as they were inline.
const DEFAULT_DEPS = {
    userStore: () => require('../stores/userStore'),
    automationAuth: () => require('../auth/automationAuth'),
    googleClient: () => require('../integrations/googleClient'),
    dispatchToSubscription: () => dispatchToSubscription,
};
let _deps = { ...DEFAULT_DEPS };

/**
 * Gmail-aware mail.new filter. The shallow `matchFilter` above is fine
 * for app events with stable scalar payloads (msgraph webhooks, GitHub
 * push events) but Gmail's enriched payload — `from` is a header like
 * `"Boss Smith <boss@example.com>"`, `labelIds` is an array, `subject`
 * needs substring match — needs richer semantics.
 *
 * Supported filter fields (all optional; ALL specified fields must
 * match — AND across keys, OR within an array on a single key):
 *
 *   from              string, substring (case-insensitive). Matches the
 *                     raw From header so "boss@example.com" hits when
 *                     the header is "Boss Smith <boss@example.com>".
 *   to                same, against the To header.
 *   cc                same, against the Cc header.
 *   subjectContains   string, substring on Subject (case-insensitive).
 *   subjectRegex      string, JS regex against Subject. Capped at 200
 *                     chars; invalid patterns silently fail-closed (no
 *                     match), so a typo can't fire on every email.
 *   labelIds          string[]; match if the message has ANY of these.
 *   excludeLabelIds   string[]; match only if the message has NONE.
 *   hasAttachment     boolean; matches when the enriched payload has at
 *                     least one entry in `attachments[]`. Falls back to the
 *                     HAS_ATTACHMENT system label for legacy payloads.
 *   excludeFromSelf   boolean; drops messages the user sent themselves
 *                     (uses the SENT system label).
 *   maxAgeMinutes     number; drops messages whose Date header is older
 *                     than N minutes. Useful as a freshness cap so a
 *                     paused poller doesn't flood the user with backlog
 *                     when it resumes.
 */

// ── Polling pass (Gmail history, Calendar syncToken) ────

async function runPollingPass() {
    const subs = await automationStore.getPollingSubscriptions({ olderThanMs: 60_000 });
    if (subs.length > 0) {
        log.info(`[TriggerBus] poll tick — ${subs.length} due subscription(s)`);
    }
    // Shared across the whole pass: identical tool calls collapse into one,
    // entitlements resolve once per user, and a call budget caps blast radius.
    const passCtx = makePassCtx({ toolBudget: MAX_SOURCE_TOOL_CALLS_PER_PASS });
    for (const sub of subs) {
        try {
            const handler = POLLERS[sub.provider]?.[sub.eventType];
            if (!handler) {
                // No hand-written poller: fall through to the declaration-driven
                // runtime. It deliberately does NOT take a `session` — that
                // builds Google/Nextcloud OAuth behind a fixed allowlist a new
                // provider can never be in, while MCP and custom integrations
                // resolve their own per-user credentials from the userId.
                await runDeclaredSource(sub, passCtx);
                continue;
            }
            const session = await loadSession(sub.userId);
            if (!session) {
                // Silent skip hides every
                // missing-credential bug. Log it loudly and escalate after
                // the threshold so the user sees a notification instead of
                // an automation that quietly stops firing.
                log.warn(`[TriggerBus] no credentials for user ${sub.userId} (provider=${sub.provider}); skipping sub ${sub.id}`);
                await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
                await escalateSubscriptionFailure(sub, POLL_FAILURE_THRESHOLD, 'no credentials');
                continue;
            }
            const events = await handler(sub, session);
            log.info(`[TriggerBus] sub ${sub.id} (${sub.provider}.${sub.eventType}) cursor=${sub.lastCursor || 'none'} → ${events.length} event(s)`);
            // Dispatch to THIS subscription only — not the broad
            // dispatchEvent() fan-out. Each subscription discovers "new
            // since my own cursor" independently; routing through the
            // provider-wide fan-out would re-dispatch to every sibling
            // subscription on the same provider+event+user every time any
            // one of them polls, double- (or N-times-) firing automations.
            for (const ev of events) {
                _deps.dispatchToSubscription()(sub, { provider: sub.provider, event: sub.eventType, payload: ev });
            }
            await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
            await automationStore.resetSubscriptionFailures(sub.id);
        } catch (e) {
            log.warn(`[TriggerBus] polling failed for sub ${sub.id}: ${/** @type {Error} */ (e).message}`);
            // Stamp lastPolledAt on the FAILURE path too. getPollingSubscriptions
            // selects `last_polled_at IS NULL OR last_polled_at < NOW() - olderThanMs`
            // and orders `last_polled_at ASC NULLS FIRST LIMIT 50` — a subscription
            // that never advances its stamp is therefore re-polled on every tick AND
            // sorts to the front of that 50-row window forever. Once ~50 subscriptions
            // are failing (one expired refresh token per user is enough), the window is
            // permanently full of them and no healthy subscription is ever polled
            // again: the whole polling fleet starves behind a handful of broken rows.
            // Escalation below is unchanged — the failure counter still climbs and
            // still notifies the user at the threshold.
            await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() })
                .catch(err => log.warn(`[TriggerBus] could not stamp lastPolledAt for sub ${sub.id}: ${err.message}`));
            await escalateSubscriptionFailure(sub, POLL_FAILURE_THRESHOLD, /** @type {Error} */ (e).message);
        }
    }
}

// Ceiling on external calls per pass regardless of how many subscriptions are
// due. The per-pass cache already collapses siblings that poll the same tool
// with the same arguments; this is the backstop.
const MAX_SOURCE_TOOL_CALLS_PER_PASS = parseInt(process.env.AUTOMATION_SOURCE_POLL_MAX_CALLS, 10) || 40;
const _noProducerLogged = new Set();

/**
 * Poll one subscription whose events come from a trigger-source declaration
 * rather than a hand-written poller.
 */
async function runDeclaredSource(sub, passCtx) {
    const stamp = () => automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
    const { getEventDef } = require('./triggerSources');
    const eventDef = getEventDef(sub.provider, sub.eventType);

    if (!eventDef || eventDef.source?.kind !== 'poll_diff') {
        // Stamping matters: the old code `continue`d without it, so this row
        // came back every 30s and logged the same line forever.
        const key = `${sub.provider}.${sub.eventType}`;
        if (!_noProducerLogged.has(key)) {
            _noProducerLogged.add(key);
            log.warn(`[TriggerBus] no producer for ${key} (sub ${sub.id}) — this subscription cannot fire`);
        }
        await stamp();
        return;
    }

    const { runPollDiff, BudgetExhausted } = require('./triggerSources/pollDiff');
    let outcome;
    try {
        outcome = await runPollDiff(sub, eventDef, passCtx);
    } catch (e) {
        if (e instanceof BudgetExhausted) {
            // A busy pass is not a broken subscription — never escalate it, or
            // users get "your trigger is failing" after five busy ticks.
            log.warn(`[TriggerBus] source poll budget exhausted; deferring sub ${sub.id}`);
            return;
        }
        throw e;
    }

    for (const ev of outcome.events) {
        _deps.dispatchToSubscription()(sub, { provider: sub.provider, event: sub.eventType, payload: ev });
    }
    if (outcome.events.length) {
        log.info(`[TriggerBus] sub ${sub.id} (${sub.provider}.${sub.eventType}) → ${outcome.events.length} event(s)`);
    }
    await stamp();
    if (outcome.skipped === 'no_capability') {
        await escalateSubscriptionFailure(sub, POLL_FAILURE_THRESHOLD, 'integration no longer available');
    } else if (!outcome.skipped) {
        await automationStore.resetSubscriptionFailures(sub.id);
    }
}

/**
 * Resolve the session-shaped credentials a polling handler needs.
 *
 * Source order:
 *   1. automationAuth vault (`automation_credentials` table) — long-lived,
 *      auto-refreshing tokens. Works for users who connected after the
 *      vault feature shipped.
 *   2. user_sessions row — same store the chat path uses via `req.session`.
 *      This is the canonical source for users who connected before the
 *      vault existed; their tokens never landed in automation_credentials.
 *
 * Both paths return the same shape: `{ accessToken, refreshToken,
 *   oauthProvider, automationProviders, _source }`. The `_source` tag lets
 * the diagnose endpoint show the user where their credentials came from
 * ("vault" / "session") so they understand whether the Integrations page
 * needs a re-connect.
 *
 * Note: the user_sessions fallback is not gated by a flag — when a user has working chat-side Gmail tokens
 * but an empty vault, we should ALWAYS use them rather than silently
 * failing the trigger. The trade-off: when their browser session expires,
 * the poller goes dark until they sign in again. Opportunistic vault
 * migration is a separate, future cleanup.
 * @param {string} userId
 */
async function loadSession(userId) {
    // Connector-bound users authenticate to NC via the ExApp reverse proxy
    // (HMAC-signed, no bearer token). Resolve their instance binding up front
    // so it can be merged into whichever credential path wins below. Without
    // it, nextcloudClient.resolveAuth has nothing to route through AND the
    // polling pass skips them entirely (loadSession → null → "no credentials"),
    // so every NC poller stays dark for the primary hosting model. getUser
    // returns raw columns, so the uid is `nc_uid` (snake_case).
    let connectorFields = null;
    try {
        const userStore = _deps.userStore();
        const u = await userStore.getUser(userId).catch((e) => fallback('automation/triggerBus:loadSession', e, null));
        if (u && u.provider === 'nextcloud_connector') {
            connectorFields = {
                connectorOrgId: u.organizationId || null,
                connectorNcUid: u.nc_uid || null,
                user: { id: userId, provider: 'nextcloud_connector', organizationId: u.organizationId || null, ncUid: u.nc_uid || null },
            };
        }
    } catch (err) { fallback('automation/triggerBus:loadSession#2', err); /* non-fatal — fall through to token paths */ }

    // 1) Vault first.
    try {
        const automationAuth = _deps.automationAuth();
        const built = await automationAuth.buildUserAuth(userId, {
            enabledIntegrations: ['gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-contacts', 'google-keep', 'google-groups', 'outlook', 'ms-calendar', 'onedrive', 'ms-contacts', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts'],
        });
        if (built && built.accessToken) {
            return {
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                oauthProvider: built.oauthProvider,
                automationProviders: built.automationProviders || {},
                _source: 'vault',
                // Merge connector binding so hybrid users (connector NC +
                // OAuth Google) can call both kinds of tool in one automation.
                ...(connectorFields || {}),
            };
        }
    } catch (err) {
        log.warn(`[TriggerBus] vault session lookup failed for user ${userId}: ${/** @type {Error} */ (err).message}`);
    }

    // 1.5) Connector-bound users have no bearer token — return the connector
    // identity directly so resolveAuth routes through /nc/* and the polling
    // pass actually runs their NC triggers.
    if (connectorFields) {
        return { ...connectorFields, automationProviders: {}, _source: 'connector' };
    }

    // 2) user_sessions fallback. Same shape as req.session for the chat path:
    //    { user: { id, ... }, accessToken, refreshToken, oauthProvider, ... }
    //    (connector-bound users already returned above at step 1.5.)
    const { pool } = require('../db');
    try {
        const { rows } = await pool.query(
            `SELECT sess FROM user_sessions
             WHERE sess::jsonb -> 'user' ->> 'id' = $1 AND expire > NOW()
             ORDER BY expire DESC LIMIT 1`, [userId],
        );
        if (!rows[0]) return null;
        const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
        if (!sess?.accessToken) return null;
        return {
            accessToken: sess.accessToken,
            refreshToken: sess.refreshToken || null,
            oauthProvider: sess.oauthProvider || null,
            automationProviders: sess.automationProviders || {},
            _source: 'session',
        };
    } catch (e) {
        log.warn(`[TriggerBus] user_sessions fallback failed for user ${userId}: ${/** @type {Error} */ (e).message}`);
        return null;
    }
}

// What the extracted modules (pollers, escalation, MS Graph renewal, latest
// match) need from the server's import cycle is handed to them here instead of
// required there, so they stay leaves (scc-ratchet). Every getter is read at
// call time: _setDepsForTests swaps automationStore and _deps after load, and
// the integration modules stay lazily required, as they were inline.
const ctx = {
    store: () => automationStore,
    googleClient: () => _deps.googleClient(),
    gmailTools: () => require('../integrations/gmailTools'),
    nextcloudActivityTools: () => require('../integrations/nextcloudActivityTools'),
    nextcloudNotificationsTools: () => require('../integrations/nextcloudNotificationsTools'),
    nextcloudCalendarTools: () => require('../integrations/nextcloudCalendarTools'),
    ncScopeGuard: () => require('../core/integrations/ncScopeGuard'),
    notificationStore: () => require('../stores/notificationStore'),
    loadSession: (userId) => loadSession(userId),
    microsoftSession: (session, userId, opts) => require('../auth/microsoftSessionHydration').resolveMicrosoftSession(session, userId, opts),
    msGraphClient: () => require('../core/integrations/integrationClients').integrationClient('msGraph'),
    escalate: (sub, threshold, errorMsg) => escalateSubscriptionFailure(sub, threshold, errorMsg),
};

/** @param {number} threshold @param {string} errorMsg */
function escalateSubscriptionFailure(sub, threshold, errorMsg) {
    return escalateWithCtx(ctx, sub, threshold, errorMsg);
}

const POLLERS = {
    gmail: createGmailPollers(ctx),
    'google-calendar': createGoogleCalendarPollers(ctx),
    'google-drive': createGoogleDrivePollers(ctx),
    nextcloud: createNextcloudPollers(ctx),
    msgraph: require('./triggerBus/pollers/msGraphMail.mts').createMsGraphPollers(ctx), // polling-mode rows: a shared mailbox's mail.new
};

function renewExpiringSubscriptions() {
    return renewWithCtx(ctx);
}

function fetchLatestGmailMatch(userId, filter) {
    return latestMatch.fetchLatestGmailMatch(ctx, userId, filter);
}

/**
 * @param {string} event
 * @param {DslFilter | null} filter
 */
function fetchLatestNextcloudMatch(userId, event, filter) {
    return latestMatch.fetchLatestNextcloudMatch(ctx, userId, event, filter);
}

/**
 * Test seam: replace any of `automationStore` (the module), `userStore`,
 * `automationAuth`, `googleClient` (getters returning the module) and
 * `dispatchToSubscription` (a getter returning the function). No argument
 * restores the real ones.
 * @param {any} [over]
 */
function _setDepsForTests(over = null) {
    const { automationStore: store, ...rest } = over || {};
    automationStore = store || REAL_AUTOMATION_STORE;
    _deps = { ...DEFAULT_DEPS, ...rest };
}

module.exports = {
    _setDepsForTests,
    dispatchEvent: withNcVisibility(dispatchEvent, (uid) => loadSession(uid)), // + the Nextcloud visibility checker
    dispatchSupportEvent,
    runPollingPass,
    renewExpiringSubscriptions,
    provisionSubscription,
    revokeSubscription,
    buildClientState,
    getPublicBaseUrl,
    fetchLatestGmailMatch,
    fetchLatestNextcloudMatch,
    loadSession,
    _ncNormaliseActivity,
    // Matchers — exported for unit testing + so other server code can
    // re-use them (e.g. a future Diagnose endpoint that wants to show
    // "would this filter match this sample payload?").
    matchGmailMailFilter,
    matchGmailLabelFilter,
    matchCalendarChangedFilter,
    matchCalendarUpcomingFilter,
    matchDriveFileNewFilter,
    matchNextcloudFileFilter,
    matchNextcloudShareFilter,
    matchNextcloudShareGenericFilter,
    matchNextcloudActivityFilter,
    matchNextcloudNotificationFilter,
    matchNextcloudCommentFilter,
    matchNextcloudTagFilter,
    matchSupportTicketResolvedFilter,
    matchNextcloudCalendarFilter,
    matchNextcloudCalendarUpcomingFilter,
    matchNextcloudDeckCardFilter,
    matchNextcloudDeckCardMovedFilter,
    matchNextcloudTalkMessageFilter,
    matchNextcloudTaskFilter,
    matchNextcloudUserStatusFilter,
    applyDslFilter,
};

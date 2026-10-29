/** @typedef {import('../../core/automationModel/dslFilters').TriggerPayload} TriggerPayload */
/** @typedef {import('../../core/automationModel/dslFilters').DslFilter} DslFilter */
// @typecheck
/**
 * Event dispatch fan-out (§WS5, extracted verbatim from triggerBus.js).
 */

const automationStore = require('../../stores/automationStore');
const { applyDslFilter } = require('../triggers/dslFilters');
const { pickMatcher, tagFilterNeedsNames } = require('./filters');
const { normaliseNextcloudPayload } = require('./ncPayload.mts');
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');

// Providers whose subscriptions are strictly per-user and where a null userId
// is NEVER legitimate. For these, an inbound event MUST identify the subscriber
// or we refuse to fan out — otherwise a forged/unauthenticated push (e.g. the
// Gmail Pub/Sub or an unmatched MS Graph notification) would broadcast to EVERY
// subscriber across all tenants. (Nextcloud is intentionally excluded: it
// legitimately dispatches with a null userId + orgId for bot/federated actors.)
const USER_SCOPED_PROVIDERS = new Set(['gmail', 'msgraph']);

// Providers that dispatch with no userId (bot/federated actors) but DO carry
// an orgId the caller resolved — for these, fan-out must be scoped to that
// org rather than left unscoped. Nextcloud is the only current member; the
// GitHub webhook path deliberately is NOT in this set — it has no per-org
// mapping to scope by yet (single global secret, see WS1.2 in events.js),
// so adding it here would silently drop every GitHub trigger instead of
// fixing the isolation gap. That needs its own installation→org mapping
// feature, tracked separately.
const ORG_SCOPED_PROVIDERS = new Set(['nextcloud']);

// Providers that predate declared scope and legitimately dispatch with neither
// a userId nor an orgId. CLOSED SET — a provider added from here on declares
// `scope: 'user' | 'org'` in its trigger-source manifest instead, and anything
// that declares neither is dropped rather than broadcast (see dispatchEvent).
// GitHub is here rather than in ORG_SCOPED_PROVIDERS because it still has no
// installation→org mapping: moving it there would silently drop every GitHub
// trigger instead of fixing the isolation gap (WS1.2 in events.js).
const LEGACY_UNSCOPED_PROVIDERS = new Set(['github', 'support']);

// Nextcloud events the activity poller owns (subscriptionSync forces
// mode='polling' for them). On a connector install the same event is ALSO
// pushed as a webhook; the push must not fire a polling-mode subscription a
// second time. Only once the poller has proven it works for that subscription
// (lastCursor is set after a successful bootstrap); until then the push stays. (Push keeps feeding the side-effect taps and webhook-mode subs.)
const NC_POLLER_OWNED_EVENTS = new Set(['file.new', 'file.changed']);

// Scope declared by a trigger-source manifest, when there is one. Required
// lazily and defensively: dispatch.js is on the hot path for every inbound
// event and must not hard-depend on the registry being loadable.
/**
 * @param {string} provider
 */
function declaredScope(provider) {
    try {
        return require('../triggerSources').getProviderScope(provider) || null;
    } catch {
        return null;
    }
}
/**
 * @param {string} p
 */
const isUserScoped = (p) => USER_SCOPED_PROVIDERS.has(p) || declaredScope(p) === 'user';
/**
 * @param {string} p
 */
const isOrgScoped = (p) => ORG_SCOPED_PROVIDERS.has(p) || declaredScope(p) === 'org';

// Shared per-call userId → orgId resolver, used to scope fan-out to the
// event's own org whenever the event itself carries no userId to match on.
function makeOrgLookup() {
    const userStore = require('../../stores/userStore');
    const orgCache = new Map();
    return async (uid) => {
        if (orgCache.has(uid)) return orgCache.get(uid);
        const u = await userStore.getUser(uid).catch((e) => fallback('automation/triggerBus/dispatch:makeOrgLookup', e, null));
        const o = u?.organizationId || null;
        orgCache.set(uid, o);
        return o;
    };
}

// Shared per-subscription match + run. Fires the automation run
// fire-and-forget (setImmediate), mirroring the ack-immediately pattern
// POST /webhook/:slug already uses — so a slow/hanging automation never
// blocks the caller (an ingest HTTP handler, or the global polling tick
// working through every other tenant's due subscriptions).
/**
 * The filter a matcher sees. `includeColleagues` is a delivery switch read by
 * dispatchEvent, not a payload condition: a matcher that compares unknown
 * keys (the shallow matchFilter) would otherwise never match.
 * @param {string} provider
 * @param {Record<string, unknown> | null | undefined} filter
 * @returns {Record<string, unknown> | null | undefined}
 */
function matchableFilter(provider, filter) {
    if (provider !== 'nextcloud' || !filter || typeof filter !== 'object' || !Object.hasOwn(filter, 'includeColleagues')) return filter;
    const { includeColleagues: _switch, ...rest } = filter;
    return rest;
}

function runMatchedSubscription(sub, matcher, provider, event, payload) {
    const ok = matcher(payload, matchableFilter(provider, sub.filter));
    if (!ok) {
        // Don't log the raw subject/sender — that's user PII (email subjects,
        // ticket bodies, actor names) landing in plaintext server logs on every
        // event. Log only the routing metadata needed to debug a filter.
        log.info(`[TriggerBus] sub ${sub.id} filter rejected ${provider}.${event}`);
        return null;
    }
    setImmediate(async () => {
        try {
            const automation = await automationStore.getAutomation(sub.automationId);
            if (!automation) { log.warn(`[TriggerBus] sub ${sub.id} — automation ${sub.automationId} not found`); return; }
            if (!automation.isActive) { log.info(`[TriggerBus] sub ${sub.id} — automation ${automation.id} is inactive; skipping`); return; }
            if (automation.isDraft)   { log.info(`[TriggerBus] sub ${sub.id} — automation ${automation.id} is still a draft; skipping`); return; }
            const runner = require('../../core/automationRunner');
            log.info(`[TriggerBus] dispatch automation=${automation.id} via sub ${sub.id} (${provider}.${event})`);
            await runner.executeAutomation(automation, {
                triggerKind: 'app_event',
                triggerPayload: { provider, event, ...payload },
                // Seed the DAG walk from the SPECIFIC trigger node this
                // subscription belongs to (definition.trigger or one of
                // definition.triggers[] — scoped multi-trigger slice).
                // sub.triggerStepId is the primary trigger's own id for
                // every subscription synced today, so this is a no-op for
                // single-trigger automations (runDag falls back to
                // def.trigger.id when the resolved id === undefined/null,
                // and resolves to the exact same id otherwise).
                rootStepId: sub.triggerStepId || null,
            });
        } catch (e) {
            log.error('[TriggerBus] dispatch error:', /** @type {Error} */ (e).message);
        }
    });
    return { subId: sub.id };
}

/**
 * Dispatch to exactly ONE subscription, bypassing the broad
 * getSubscriptionsForProvider fan-out. Used by the polling pass: each
 * subscription discovers "new since MY OWN cursor" independently, so
 * routing a polling-discovered event through the broad dispatchEvent()
 * (which fans out to every sibling subscription on the same
 * provider+event+user) double-fires automations — sub A's poll tick
 * dispatches to both A and B, then B's own poll tick later rediscovers
 * the same underlying item via its own cursor and dispatches to both
 * A and B again.
 */
function dispatchToSubscription(sub, { provider, event, payload = {} }) {
    const baseMatcher = pickMatcher(provider, event);
    /**
     * @param {TriggerPayload} p
     * @param {DslFilter | null} f
     */
    const matcher = (p, f) => applyDslFilter(p, f, baseMatcher);
    const canonical = provider === 'nextcloud' ? normaliseNextcloudPayload(event, payload) : payload;
    const result = runMatchedSubscription(sub, matcher, provider, event, canonical);
    return result ? [result] : [];
}

/**
 * Fan an inbound event out to the matching subscriptions.
 *
 * `userId` names the exact SUBSCRIBER (user-scoped providers: Gmail, MS Graph,
 * approvals ...). `actorUserId` names the Bee Flow user who CAUSED a Nextcloud
 * event (resolved from the connector's ncUid) and is never a subscriber
 * filter: a Nextcloud event fans out across `orgId`, and per subscription
 *   - the actor's own automations receive it (isOwn / isOwnAction true);
 *   - a colleague's automation receives it only when its trigger opted in
 *     (`filter.includeColleagues: true`) AND `ncVisibility` confirms, as that
 *     colleague, that they can see the resource in Nextcloud;
 *   - an event whose actor is unknown (guest, bot, federated user, public
 *     link) needs no opt-in (such events fan out to the org, as they always
 *     have) but passes the same visibility check, so a non-member never
 *     receives it.
 * @param {{ provider: string, event: string, payload?: Record<string, any>, userId?: string | null, orgId?: string | null,
 *   actorUserId?: string | null, ncVisibility?: import('./ncVisibility.mts').NcVisibility | null }} args
 */
async function dispatchEvent({ provider, event, payload: rawPayload = {}, userId = null, orgId = null, actorUserId = null, ncVisibility = null }) {
    const payload = provider === 'nextcloud' ? normaliseNextcloudPayload(event, rawPayload) : rawPayload;
    // Security: never fan a user-scoped provider's event out to all tenants when
    // the subscriber is unknown. Drop it instead (fail closed).
    if (!userId && isUserScoped(provider)) {
        log.warn(`[TriggerBus] dropping ${provider}.${event} with no userId — user-scoped events must identify the subscriber (no cross-tenant fan-out)`);
        return [];
    }
    // Org-scoped providers (Nextcloud bot/federated actors) legitimately have
    // no userId, but MUST still carry orgId — without it there is nothing to
    // scope the fan-out to, so treat it the same as the user-scoped case above.
    if (!userId && isOrgScoped(provider) && !orgId) {
        log.warn(`[TriggerBus] dropping ${provider}.${event} with no userId and no orgId — cannot scope fan-out (no cross-tenant leak)`);
        return [];
    }
    // Fail closed by default. A provider in NEITHER hardcoded set
    // that arrives unidentified would fan out to every subscriber in every
    // organisation. With providers now declarable at runtime that default is
    // untenable: an unidentified event is only let through for the closed
    // legacy allowlist above.
    if (!userId && !orgId && !LEGACY_UNSCOPED_PROVIDERS.has(provider)) {
        log.warn(`[TriggerBus] dropping ${provider}.${event} — no userId, no orgId and no declared scope (no cross-tenant fan-out)`);
        return [];
    }
    // Side-effect tap: a new Nextcloud file might be a Talk call recording we
    // should auto-transcribe into Meeting Notes. This runs independently of
    // user-created automation subscriptions and must never block their
    // fan-out, so it is fire-and-forget with its own error handling.
    if (provider === 'nextcloud' && event === 'file.new') {
        try {
            require('../../core/meetingNotes/talkAutoIngest').maybeIngest({ payload, userId: userId || actorUserId, orgId })
                .catch(e => log.error('[TalkAutoIngest] tap error:', e.message));
        } catch (e) {
            log.error('[TalkAutoIngest] tap load error:', /** @type {Error} */ (e).message);
        }
    }
    // Side-effect tap: a finished meeting arms the knowledge sources that
    // watch its tags (K7), so "after every meeting" means what it says rather
    // than "on the next nightly pass". Same posture as the tap above —
    // independent of user subscriptions, fire-and-forget, and it must never
    // block their fan-out.
    if (provider === 'meeting-notes' && event === 'meeting.processed') {
        try {
            Promise.resolve(require('../../jobs/kbSourceRefresh').onMeetingProcessed(payload))
                .catch(e => log.error('[KBSourceRefresh] tap error:', e.message));
        } catch (e) {
            log.error('[KBSourceRefresh] tap load error:', /** @type {Error} */ (e).message);
        }
    }

    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    const runs = [];
    const baseMatcher = pickMatcher(provider, event);
    // Wrap baseMatcher with the rich-filter DSL so any/none/expr/age work
    // for every matcher consistently (Phase 1.4). The DSL is no-op when
    // the filter has no DSL keys, so existing flows are unchanged.
    /**
     * @param {TriggerPayload} p
     * @param {DslFilter | null} f
     */
    const matcher = (p, f) => applyDslFilter(p, f, baseMatcher);
    // userId identifies the exact subscriber — filter to just that user.
    // Otherwise, for org-scoped providers (Nextcloud) scope fan-out to
    // subscribers who belong to the event's org.
    const orgScoped = !userId && isOrgScoped(provider);
    const lookupOrg = orgScoped ? makeOrgLookup() : null;
    const pollerOwned = provider === 'nextcloud' && NC_POLLER_OWNED_EVENTS.has(event);
    // Nextcloud org fan-out: the actor is not a subscriber filter.
    const ncFanOut = provider === 'nextcloud' && !userId;
    /** @type {import('./ncVisibility.mts').VisibilityMemo} */
    const memo = new Map();
    const eligible = [];
    for (const sub of subs) {
        if (pollerOwned && sub.mode === 'polling' && sub.lastCursor) continue;
        if (userId && sub.userId !== userId) continue;
        if (orgScoped) {
            const subOrg = await lookupOrg(sub.userId);
            if (subOrg !== orgId) continue;
        }
        eligible.push(sub);
    }
    // The per-subscriber Nextcloud checks run side by side: the connector
    // holds its webhook open until this returns.
    const payloads = await Promise.all(eligible.map(async (sub) => {
        let subPayload = payload;
        if (ncFanOut) {
            const own = !!actorUserId && sub.userId === actorUserId;
            if (!own) {
                const overrides = await ncDeliveryFor({ sub, event, payload, actorKnown: !!actorUserId, ncVisibility, memo });
                if (!overrides) return null;
                subPayload = { ...payload, ...overrides };
            }
            // Stamped per subscription: the excludeOwnUploads / excludeOwnMessages
            // filters read these, and "own" means THIS subscriber caused it.
            subPayload = { ...subPayload, isOwn: own, isOwnAction: own };
        }
        if (provider === 'nextcloud' && (event === 'file.tagged' || event === 'file.untagged')
            && ncVisibility && tagFilterNeedsNames(sub.filter) && !Array.isArray(subPayload.tagNames)) {
            subPayload = { ...subPayload, tagNames: await ncVisibility.tagNames(sub.userId, subPayload.tagIds ?? [subPayload.tagId], memo) };
        }
        return subPayload;
    }));
    eligible.forEach((sub, i) => {
        if (!payloads[i]) return;
        const result = runMatchedSubscription(sub, matcher, provider, event, payloads[i]);
        if (result) runs.push(result);
    });
    return runs;
}

/**
 * May a Nextcloud event reach a subscription whose owner did NOT cause it?
 * Returns the payload overrides for that subscriber (possibly empty), or null
 * for "do not deliver". See dispatchEvent and ncVisibility.mts.
 * @param {{ sub: { id?: string, userId: string, filter?: Record<string, any> | null }, event: string, payload: Record<string, any>,
 *   actorKnown: boolean, ncVisibility: import('./ncVisibility.mts').NcVisibility | null,
 *   memo: import('./ncVisibility.mts').VisibilityMemo }} args
 * @returns {Promise<Record<string, any> | null>}
 */
async function ncDeliveryFor({ sub, event, payload, actorKnown, ncVisibility, memo }) {
    // A colleague's event is opt-in per trigger; an unknown actor's is not
    // (those always fanned out), but both are checked.
    const filter = sub.filter || {};
    if (actorKnown && filter.includeColleagues !== true) return null;
    if (!ncVisibility) return null;
    const decision = await ncVisibility.check(sub.userId, event, payload, memo);
    if (!decision?.visible) {
        log.info(`[TriggerBus] sub ${sub.id} skipped nextcloud.${event}: not visible to its owner in Nextcloud`);
        return null;
    }
    return decision.overrides || {};
}

/**
 * Org-scoped dispatch. Events live at the organisation level (not user
 * level), so we route to every
 * subscription whose subscriber belongs to `orgId`. Anyone outside that
 * org never sees the event — the regular `dispatchEvent` would have
 * required us to fan out one call per user, which is wasteful.
 *
 * Per-call cache keyed by userId avoids repeated `userStore.getUser`
 * lookups when many subscriptions share a subscriber.
 */
// §WS4.2 — single org-scoped fan-out. The Support path
// were byte-for-byte twins differing only in the provider string + log prefix.
// Both events live at the ORG level (not user level), so we route to every
// subscription whose subscriber belongs to `orgId`. The per-call userId→orgId
// cache avoids repeated userStore.getUser lookups when many subscriptions share
// a subscriber.
/**
 * @param {string} provider
 * @param {string} event
 */
async function dispatchOrgScopedEvent(provider, event, payload = {}, orgId = null) {
    if (!event) return [];
    // Security: this dispatch path exists specifically to scope fan-out to
    // one org. Without orgId there is nothing to scope to, so fail closed —
    // the same posture dispatchEvent takes for an unidentified subscriber —
    // rather than silently falling through to every subscriber of every org.
    if (!orgId) {
        log.warn(`[TriggerBus] dropping org-scoped ${provider}.${event} with no orgId (no cross-tenant fan-out)`);
        return [];
    }
    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    if (subs.length === 0) return [];

    const lookupOrg = makeOrgLookup();

    const runs = [];
    // Wrap with the rich-filter DSL exactly like dispatchEvent and
    // dispatchToSubscription do. Without it any/none/expr/age filters were
    // silently ignored on this path, so an automation fired on events its
    // author had explicitly excluded.
    const baseMatcher = pickMatcher(provider, event);
    /**
     * @param {TriggerPayload} p
     * @param {DslFilter | null} f
     */
    const matcher = (p, f) => applyDslFilter(p, f, baseMatcher);
    for (const sub of subs) {
        const subOrg = await lookupOrg(sub.userId);
        if (subOrg !== orgId) continue;
        const result = runMatchedSubscription(sub, matcher, provider, event, payload);
        if (result) runs.push(result);
    }
    return runs;
}

/**
 * @param {string} event
 */
const dispatchSupportEvent = (event, payload = {}, orgId = null) =>
    dispatchOrgScopedEvent('support', event, payload, orgId);

module.exports = { dispatchEvent, dispatchToSubscription, dispatchOrgScopedEvent, dispatchSupportEvent };

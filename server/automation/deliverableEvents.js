/**
 * Single source of truth for "will this app_event trigger actually fire?"
 *
 * This drives a NON-BLOCKING validation WARNING and UI badges only. It does
 * NOT change how Nextcloud connects, how subscriptions are delivered, or how
 * the connector behaves — it is purely an honesty signal for the builder and
 * the routines gallery.
 *
 * Three sets for Nextcloud, reflecting the two producers we actually have:
 *
 *   POLLER_BACKED   — events with a real triggerBus poller, so they fire on the
 *                     SaaS poll tick with no connector dependency at all.
 *                     (Mirror of POLLERS.nextcloud keys in triggerBus.js:~1172
 *                     + calendar.event.upcoming. POLLERS is not exported, so we
 *                     keep this list in sync by hand — keep it aligned with
 *                     triggerBus. There is no longer a second copy in
 *                     routes/automation.js; the per-event mode resolution there
 *                     reads these sets instead.)
 *
 *   WEBHOOK_BACKED  — events Nextcloud pushes to the Bee Flow ExApp connector
 *                     through its bundled `webhook_listeners` app. Delivery is
 *                     near-instant (subject to the admin running background-job
 *                     workers) but needs the connector installed.
 *
 *                     Membership is not a product choice: `WebhooksEventListener`
 *                     calls `getWebhookSerializable()`, so only event classes
 *                     implementing `OCP\EventDispatcher\IWebhookCompatibleEvent`
 *                     can be registered — Files, SystemTag, Calendar, Forms and
 *                     Tables. Adding anything else here means registering a
 *                     class that makes Nextcloud fatal inside a background job.
 *
 *   BOT_BACKED      — Talk chat events, delivered by the Bee Flow Talk bot
 *                     (nextcloud-connector/src/talkBot.js). Talk exposes no
 *                     webhook-compatible event class, so a bot is the supported
 *                     mechanism — and a better-scoped one: the bot only sees
 *                     conversations a moderator explicitly added it to, so
 *                     there is no instance-wide chat firehose.
 *
 *   PUSH_PENDING    — events with NO producer at all. Nextcloud exposes no
 *                     webhook-compatible event class for Share, and we have no
 *                     poller for it either, so a routine that subscribes to one
 *                     of these will not fire. These stay flagged in the builder
 *                     until upstream makes the event classes
 *                     webhook-compatible, or we add a poller.
 *
 * Historical note: this file used to list every file/calendar/deck/talk
 * mutation as PUSH_PENDING because the connector subscribed through AppAPI's
 * `events_listener` API — which Nextcloud has since removed, so none of them
 * could fire. File and calendar moved to WEBHOOK_BACKED when the connector was
 * rewritten onto `webhook_listeners`. Deck followed once we noticed our own
 * "Deck exposes nothing" comment had gone stale: `ACardEvent` has implemented
 * `IWebhookCompatibleEvent` since Deck v1.18.0 (2026-05-03). Talk is served by
 * the bot instead — its events are genuinely not webhook-compatible.
 */

const POLLER_BACKED = {
    nextcloud: new Set([
        'file.new',
        'file.changed',
        'share.received',
        'activity.new',
        'notification.new',
        'calendar.event.upcoming',
    ]),
};

// Delivered by nextcloud-connector/src/webhookListeners.js — keep in sync with
// the EVENTS table there.
const WEBHOOK_BACKED = {
    nextcloud: new Set([
        'file.new',
        'file.changed',
        'file.deleted',
        'file.renamed',
        'file.copied',
        'file.restored',
        'file.tagged',
        'file.untagged',
        'calendar.event.created',
        'calendar.event.changed',
        'calendar.event.deleted',
        'calendar.event.moved',
        'forms.submitted',
        'tables.row.added',
        'tables.row.updated',
        'tables.row.deleted',
        'deck.card.created',
        'deck.card.changed',
        'deck.card.deleted',
        // Derived, not registered: Deck fires one CardUpdatedEvent for every
        // mutation and serialises only the current card, so these two are
        // reconstructed by deckTransitions() from the last state the connector
        // saw. A cache miss (first sighting, restart, eviction, second replica)
        // yields `changed` alone — a false negative, never a false positive.
        'deck.card.completed',
        'deck.card.moved',
    ]),
};

// Delivered by the Talk bot — keep in sync with mapActivity() in
// nextcloud-connector/src/talkBot.js.
const BOT_BACKED = {
    nextcloud: new Set([
        'talk.message.received',
        'talk.reaction.added',
    ]),
};

// Events with no producer at all. `OCP\Share\Events\ShareCreatedEvent` and
// `ShareDeletedEvent` still `extends Event` with no IWebhookCompatibleEvent on
// server HEAD, so they cannot be webhooked, and there is no poller for them.
// This is the last hole in the catalogue and the one clean upstream ask left.
const PUSH_PENDING = {
    nextcloud: new Set([
        'share.created',
        'share.deleted',
    ]),
};

function union(...sets) {
    const out = new Set();
    for (const s of sets) for (const v of s) out.add(v);
    return out;
}

/**
 * The set passed to validateDefinition({ deliverableEvents }). Keyed by
 * provider; an event ABSENT from its provider's set yields the non-blocking
 * `trigger.app_event_undeliverable` warning (validate.js).
 *
 * Webhook-backed events count as deliverable: the connector is the primary
 * hosting model, and an org without it still gets the poller-backed subset.
 * Only events with no producer whatsoever warn.
 */
function getDeliverableEvents() {
    return {
        nextcloud: union(POLLER_BACKED.nextcloud, WEBHOOK_BACKED.nextcloud, BOT_BACKED.nextcloud),
    };
}

/** True when an event has no producer — neither a poller nor a webhook. */
function isPushPending(provider, event) {
    return !!PUSH_PENDING[provider]?.has(event);
}

/** True when an event fires today via a SaaS poller (no connector needed). */
function isPollerBacked(provider, event) {
    return !!POLLER_BACKED[provider]?.has(event);
}

/** True when Nextcloud pushes this event to the connector. */
function isWebhookBacked(provider, event) {
    return !!WEBHOOK_BACKED[provider]?.has(event);
}

/** True when the Talk bot delivers this event. */
function isBotBacked(provider, event) {
    return !!BOT_BACKED[provider]?.has(event);
}

/** Arrays (JSON-serialisable) for the /catalog payload consumed by the client. */
function deliverabilityForCatalog() {
    return {
        pollerBacked: { nextcloud: [...POLLER_BACKED.nextcloud] },
        webhookBacked: { nextcloud: [...WEBHOOK_BACKED.nextcloud] },
        botBacked: { nextcloud: [...BOT_BACKED.nextcloud] },
        pushPending: { nextcloud: [...PUSH_PENDING.nextcloud] },
    };
}

module.exports = {
    POLLER_BACKED,
    WEBHOOK_BACKED,
    BOT_BACKED,
    PUSH_PENDING,
    getDeliverableEvents,
    isPushPending,
    isPollerBacked,
    isWebhookBacked,
    isBotBacked,
    deliverabilityForCatalog,
};

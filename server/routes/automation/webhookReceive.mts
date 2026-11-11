/**
 * One delivery to an automation webhook (POST /api/automation/webhook/:slug, events.js): from
 * the request to the run it starts. The signing recipe is in webhookSignature.js and in the
 * docs (features/automations.md, "Webhook trigger format").
 *
 * THE ORDER, and what a sender is told at each step:
 *   1. the address names a webhook, and the signature fits its secret, and the timestamp
 *      (when one is sent) is inside the window              no: 401 "Delivery not accepted"
 *   2. the nonce is new                                     seen: 401 "Replayed nonce"
 *   3. the automation is active, and the webhook's trigger is live
 *                                                           no: 409
 *   4. the run starts                                       202 { accepted, automationId }
 *
 * Step 1 is ONE answer: an address that does not accept a delivery says the same whatever the
 * reason (no such address, a missing or different signature, a timestamp outside the window).
 * An address that names no webhook is still checked against a key nobody holds, so it does the
 * same work as one that does. Steps 2 and 3 are reached only by a delivery that was signed with
 * the webhook's secret; their answers are the documented ones a sender may act on.
 */

import { randomBytes } from 'node:crypto';

type Obj = Record<string, unknown>;

export type Delivery = {
    slug: string;
    signature: string; nonce: string; timestamp: string | null;
    /** The body as sent (when the parser kept it) and as parsed. */
    rawBody: string | null; body: unknown;
    /** The request headers a run may read (events.js pickWebhookHeaders). */
    headers: Record<string, string>;
};

export type Webhook = { id: string; automationId: string; secret: string | null; triggerStepId?: string | null };
type Automation = Obj & { id: string; isActive?: boolean; isDraft?: boolean; liveVersion?: number | null };
type Check = { ok: boolean; reason?: 'missing' | 'stale_timestamp' | 'bad_signature' };

export type ReceiveDeps = {
    store: {
        getWebhook: (slug: string) => Promise<Webhook | null>;
        checkAndStoreNonce: (nonce: string, options: { retain: boolean }) => Promise<boolean>;
        touchWebhook: (slug: string) => Promise<unknown>;
        getAutomation: (id: string) => Promise<Automation | null>;
    };
    /** webhookSignature.js checkWebhookSignature. */
    check: (input: { secret: string | null; sigHeader: string; nonce: string; timestamp: string | null; rawBody: string | null; body: unknown }) => Check;
    liveHasTrigger: (automation: Automation, triggerStepId: string) => boolean;
    execute: (automation: Automation, options: Obj) => Promise<unknown>;
    log: { error: (...a: unknown[]) => void };
};

export type Answer = { status: 202 | 401 | 409; body: Obj };

/** The one answer of an address that does not accept a delivery. */
export const NOT_ACCEPTED: Answer = Object.freeze({ status: 401, body: Object.freeze({ error: 'Delivery not accepted' }) });

/** A key nobody holds: an address that names no webhook is checked against it. */
const DECOY_SECRET = randomBytes(32).toString('hex');

export type Verified = { ok: true; webhook: Webhook } | { ok: false; webhook: Webhook | null; reason: NonNullable<Check['reason']> | 'unknown' };

/** Step 1: the webhook the address names, when the delivery was signed with its secret. */
export async function verifyDeliverySignature(d: Delivery, deps: ReceiveDeps): Promise<Verified> {
    const webhook = await deps.store.getWebhook(d.slug);
    const check = deps.check({
        secret: webhook?.secret || DECOY_SECRET,
        sigHeader: d.signature, nonce: d.nonce, timestamp: d.timestamp, rawBody: d.rawBody, body: d.body,
    });
    if (!webhook) return { ok: false, webhook: null, reason: 'unknown' };
    if (!check.ok || !webhook.secret) return { ok: false, webhook, reason: check.reason || 'bad_signature' };
    return { ok: true, webhook };
}

/** Steps 2 to 4, for a delivery that passed step 1. */
export async function startSignedDelivery(webhook: Webhook, d: Delivery, deps: ReceiveDeps): Promise<Answer> {
    // A delivery without a timestamp never expires on its own: its nonce is kept beyond the
    // 24 h sweep so the same request cannot be sent again.
    const fresh = await deps.store.checkAndStoreNonce(`${d.slug}:${d.nonce}`, { retain: !d.timestamp });
    if (!fresh) return { status: 401, body: { error: 'Replayed nonce' } };

    await deps.store.touchWebhook(d.slug);
    const automation = await deps.store.getAutomation(webhook.automationId);
    if (!automation || !automation.isActive || automation.isDraft) {
        return { status: 409, body: { error: 'Automation is not active' } };
    }
    // The run executes the LIVE definition. A webhook issued for a trigger that so far exists
    // only in the working copy is not live yet: firing it would enter the live flow at its
    // primary trigger instead.
    if (automation.liveVersion != null && webhook.triggerStepId && !deps.liveHasTrigger(automation, webhook.triggerStepId)) {
        return { status: 409, body: { error: 'This webhook\'s trigger is not live yet. Publish the automation first.', code: 'trigger_not_live' } };
    }
    // The run goes on after the answer.
    setImmediate(async () => {
        try {
            await deps.execute(automation, {
                triggerKind: 'webhook',
                triggerPayload: d.body || {},
                // Request headers, additively at trigger.headers.<name>, OUTSIDE trigger.output,
                // which stays the raw POST body: header names never collide with body fields.
                triggerHeaders: d.headers,
                // The trigger node this webhook was issued for (definition.trigger or one of
                // definition.triggers[]).
                rootStepId: webhook.triggerStepId || null,
            });
        } catch (e) {
            deps.log.error('[automation/webhook] run error:', (e as Error).message);
        }
    });
    return { status: 202, body: { accepted: true, automationId: automation.id } };
}

/**
 * One delivery to an automation webhook (POST /api/automation/webhook/:slug, events.js): from
 * the request to the run it starts. The signing recipe is in webhookSignature.js and in the
 * docs (features/automations.md, "Webhook trigger format").
 *
 * THE ORDER, and what a sender is told at each step:
 *   1. the address names a webhook, and the signature fits its secret (or, during a
 *      rotation's overlap, the one before), and the timestamp (when one is sent) is inside
 *      the window                                           no: 401 "Delivery not accepted"
 *   2. the nonce is new                                     seen: 401 "Replayed nonce"
 *   3. the automation is active, and the webhook's trigger is live
 *                                                           no: 409
 *   4. the run starts                                       202 { accepted, automationId }
 *
 * Step 1 is ONE answer: an address that does not accept a delivery says the same whatever the
 * reason (no such address, a missing or different signature, a timestamp outside the window).
 * Every delivery is checked against two keys, the secret and the one before it; where there is
 * none (no webhook at the address, no rotation going on) a key nobody holds takes its place, so
 * every address does the same work. Steps 2 and 3 are reached only by a delivery that was signed with
 * the webhook's secret; their answers are the documented ones a sender may act on.
 *
 * WHAT IS KEPT (stores/automationStore/webhookDeliveries.js), for the owner, who reads it on the
 * webhook row in the builder: per delivery to an address that names a webhook, what became of
 * it, the size of the body and when; for a delivery that was signed with the webhook's secret
 * also a sha256 of the body. No body, no header, no address of the sender. A delivery that
 * started no run is written at most AUTOMATION_WEBHOOK_REJECT_LOG_PER_MINUTE times per webhook
 * per minute. Writing the log never changes the answer.
 */

import { createHash, randomBytes } from 'node:crypto';

type Obj = Record<string, unknown>;

export type Delivery = {
    slug: string;
    signature: string; nonce: string; timestamp: string | null;
    /** The body as sent (when the parser kept it) and as parsed. */
    rawBody: string | null; body: unknown;
    /** The request headers a run may read (events.js pickWebhookHeaders). */
    headers: Record<string, string>;
};

export type Webhook = { id: string; automationId: string; secret: string | null; previousSecret?: string | null; triggerStepId?: string | null };
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
    /** Write one delivery to the log (the store's logWebhookDelivery). */
    logDelivery: (d: { webhookId: string; status: DeliveryStatus; bodyBytes: number; bodySha256?: string | null }) => Promise<unknown>;
    /** Deliveries that started no run written per webhook per minute (0 = all of them). */
    rejectLogPerMinute: () => number;
    now?: () => number;
    log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
};

export type DeliveryStatus = 'accepted' | 'bad_signature' | 'stale_timestamp' | 'replay' | 'inactive' | 'trigger_not_live';

const refusedLog = new Map<string, { minute: number; count: number }>();
/** Test-only: forget how many deliveries were written this minute. */
export const _resetRefusedLog = (): void => refusedLog.clear();

/** Is there room this minute for one more delivery of this webhook that started no run? */
function roomForRefused(webhookId: string, max: number, now: number): boolean {
    if (!max) return true;
    const minute = Math.floor(now / 60_000);
    if (refusedLog.size > 10_000) refusedLog.clear();
    const seen = refusedLog.get(webhookId);
    const count = seen && seen.minute === minute ? seen.count + 1 : 1;
    refusedLog.set(webhookId, { minute, count });
    return count <= max;
}

/** Write what became of a delivery. Never throws: the log is the owner's, the answer the sender's. */
async function record(webhook: Webhook, status: DeliveryStatus, d: Delivery, deps: ReceiveDeps, { signed }: { signed: boolean }): Promise<void> {
    try {
        if (status !== 'accepted' && !roomForRefused(webhook.id, deps.rejectLogPerMinute(), (deps.now || Date.now)())) return;
        const sent = d.rawBody ?? JSON.stringify(d.body === undefined || d.body === null ? {} : d.body);
        await deps.logDelivery({
            webhookId: webhook.id, status, bodyBytes: Buffer.byteLength(sent, 'utf8'),
            bodySha256: signed ? createHash('sha256').update(sent, 'utf8').digest('hex') : null,
        });
    } catch (e) {
        deps.log.warn(`[automation/webhook] webhook=${webhook.id.slice(0, 8)} could not log a delivery (${(e as Error)?.name || 'error'})`);
    }
}

export type Answer = { status: 202 | 401 | 409; body: Obj };

/** The one answer of an address that does not accept a delivery. */
export const NOT_ACCEPTED: Answer = Object.freeze({ status: 401, body: Object.freeze({ error: 'Delivery not accepted' }) });

/** A key nobody holds: it stands in wherever a delivery has no secret to be checked against. */
const DECOY_SECRET = randomBytes(32).toString('hex');

export type Verified = { ok: true; webhook: Webhook } | { ok: false; webhook: Webhook | null; reason: NonNullable<Check['reason']> | 'unknown' };

/** Step 1: the webhook the address names, when the delivery was signed with its secret. */
export async function verifyDeliverySignature(d: Delivery, deps: ReceiveDeps): Promise<Verified> {
    const webhook = await deps.store.getWebhook(d.slug);
    const signedWith = (secret: string | null | undefined): Check => {
        const check = deps.check({
            secret: secret || DECOY_SECRET,
            sigHeader: d.signature, nonce: d.nonce, timestamp: d.timestamp, rawBody: d.rawBody, body: d.body,
        });
        return secret ? check : { ok: false, reason: check.reason || 'bad_signature' };
    };
    // Both are always checked: the secret, and the one before it while its overlap lasts.
    const current = signedWith(webhook?.secret);
    const previous = signedWith(webhook?.previousSecret);
    if (!webhook) return { ok: false, webhook: null, reason: 'unknown' };
    if (!current.ok && !previous.ok) {
        const reason = current.reason || 'bad_signature';
        // Not awaited: the answer of an address with a webhook takes no longer than that of one without.
        void record(webhook, reason === 'stale_timestamp' ? 'stale_timestamp' : 'bad_signature', d, deps, { signed: false });
        return { ok: false, webhook, reason };
    }
    return { ok: true, webhook };
}

/** Steps 2 to 4, for a delivery that passed step 1. */
export async function startSignedDelivery(webhook: Webhook, d: Delivery, deps: ReceiveDeps): Promise<Answer> {
    // A delivery without a timestamp never expires on its own: its nonce is kept beyond the
    // 24 h sweep so the same request cannot be sent again.
    const fresh = await deps.store.checkAndStoreNonce(`${d.slug}:${d.nonce}`, { retain: !d.timestamp });
    const signed = { signed: true };
    if (!fresh) {
        await record(webhook, 'replay', d, deps, signed);
        return { status: 401, body: { error: 'Replayed nonce' } };
    }

    await deps.store.touchWebhook(d.slug);
    const automation = await deps.store.getAutomation(webhook.automationId);
    if (!automation || !automation.isActive || automation.isDraft) {
        await record(webhook, 'inactive', d, deps, signed);
        return { status: 409, body: { error: 'Automation is not active' } };
    }
    // The run executes the LIVE definition. A webhook issued for a trigger that so far exists
    // only in the working copy is not live yet: firing it would enter the live flow at its
    // primary trigger instead.
    if (automation.liveVersion != null && webhook.triggerStepId && !deps.liveHasTrigger(automation, webhook.triggerStepId)) {
        await record(webhook, 'trigger_not_live', d, deps, signed);
        return { status: 409, body: { error: 'This webhook\'s trigger is not live yet. Publish the automation first.', code: 'trigger_not_live' } };
    }
    await record(webhook, 'accepted', d, deps, signed);
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

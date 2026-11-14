/**
 * One delivery to a webhook trigger: from the request to the run it starts.
 *
 * THE RECIPE a sender follows (the Triggers panel shows it with the address):
 *
 *   POST <address>                      Content-Type: application/json
 *   X-BeeFlow-Timestamp: <unix seconds>
 *   X-BeeFlow-Nonce:     <an id of this delivery, 8 to 128 of A-Z a-z 0-9 . _ : ->
 *   X-BeeFlow-Signature: sha256=<hex HMAC-SHA256 of  nonce "\n" timestamp "\n" body  with the secret>
 *
 * The same headers, signature form and primitives as the automation webhook
 * (usecases/automation/webhookSignature.js; the route hands `sign` and `same` in), with two things
 * stricter: the timestamp is required, and only the bytes that were sent are signed.
 *
 * THE ORDER, and what a caller learns at each step:
 *   1. the address names an endpoint                         no: 404
 *   2. the signature fits the secret (or, during a rotation's overlap, the previous one),
 *      compared in constant time                             no: 404
 *   3. the timestamp is inside the window                    no: 404
 *   4. the trigger is armed (its row exists and is not paused) and, inside the fire, the app is
 *      published, the owner active, the trigger what was armed (unattendedIdentity.mts)
 *                                                            no: 404
 *   5. the trigger's deliveries per minute                   over: 429
 *   6. the body is a JSON object or list, not nested too deep  no: 400
 *   7. the delivery id is new                                seen: 202 with the first delivery's id, nothing starts
 *   8. the run starts through fireTrigger                    a run of this trigger still going, or a limit: 429
 *                                                            started: 202 { deliveryId }
 * Everything up to 4 answers the SAME 404, so a caller without the secret cannot tell an unknown
 * address from a wrong signature, a paused trigger or an unpublished app; the owner reads the
 * reason in the delivery log. Only a caller that signed correctly for an armed trigger gets a
 * 400 or a 429. (Too large a body and a wrong content type are answered by the route before any
 * of this, the same for every address.)
 *
 * WHO AND WHAT. The endpoint row names the app and the trigger; nothing in the request does. The
 * run is the app owner's (fireTrigger), one at a time per trigger. The body is handed to the
 * action as `trigger.webhook.body` and is untrusted input there.
 *
 * WHAT IS KEPT. Per delivery: the outcome, the size and a sha256 of the body, the run it
 * started, and a hash of the delivery id. No body, no header, no address of the sender. What a
 * sender puts in a body is the sender's choice; it lives in the run (and in a run on hold) like
 * any other run value and is cleared with it. Logs carry ids and outcomes only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { TriggerRow, TriggerStore } from '../../../stores/studioAppData/triggers.mts';
import type { DeliveryStatus, WebhookEndpoint, WebhookTriggerStore } from '../../../stores/studioAppData/webhookTriggers.mts';
import { webhookLimits } from '../../../stores/studioAppData/webhookPolicy.mts';
import type { WebhookLimits } from '../../../stores/studioAppData/webhookPolicy.mts';
import { defaultFireDeps, fireTrigger, settleOutcome } from '../triggerFire.mts';
import type { FireDeps } from '../triggerFire.mts';
import { triggerScope } from '../triggerScope.mts';
import { WEBHOOK_KIND, isEndpointId } from './webhookEndpoints.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Take = { ok: true } | { ok: false; retryAfterSecs: number };

export type Delivery = {
    endpointId: string;
    signature: string; timestamp: string; nonce: string;
    /** The bytes of the body exactly as sent. */
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
};

export type ReceiveResult =
    | { status: 202; body: { accepted: true; deliveryId: string; duplicate?: true } }
    | { status: 404 }
    | { status: 400; code: string; error: string }
    | { status: 429; code: string; error: string; retryAfterSecs: number };

export type ReceiveDeps = {
    store: () => WebhookTriggerStore;
    triggers: () => TriggerStore;
    /** A sealed secret in clear, or null. */
    open: (cipher: string) => string | null;
    /** `sha256=<hex>` of `message` under `secret`, and the constant-time compare of two such headers. */
    sign: (secret: string, message: string) => string;
    same: (given: string, expected: string) => boolean;
    /** Charge one delivery to the trigger's per-minute budget. */
    take: (key: string, max: number) => Promise<Take>;
    fire: () => FireDeps;
    now: () => number;
    limits: () => WebhookLimits;
    newDeliveryId: () => string;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
};

const NOT_FOUND: ReceiveResult = { status: 404 };
/** A claim that was never finished is free again after this long. */
const CLAIM_STALE_MS = 60_000;
const BUSY_RETRY_SECS = 15;

// ── The per-trigger budget (fleet-wide with Redis, per process without) ─────────────────────

type Limiter = { take: (key: string) => Promise<Take> };
const limiters = new Map<number, Limiter>();

function defaultTake(key: string, max: number): Promise<Take> {
    if (!max) return Promise.resolve({ ok: true });
    let limiter = limiters.get(max);
    if (!limiter) {
        const { perUserRateLimit } = nodeRequire('../../../utils/perUserRateLimit.js') as { perUserRateLimit: (o: Obj) => Limiter };
        limiter = perUserRateLimit({ windowMs: 60_000, max, name: 'studio-app-webhook-trigger' });
        limiters.set(max, limiter);
    }
    return limiter.take(key);
}

export function defaultReceiveDeps(crypto: Pick<ReceiveDeps, 'sign' | 'same'>): ReceiveDeps {
    const endpoints = () => nodeRequire('./webhookEndpoints.mts') as typeof import('./webhookEndpoints.mts');
    return {
        ...crypto,
        store: () => endpoints().defaultEndpointDeps().store(),
        triggers: () => (nodeRequire('../../../stores/studioAppData/triggers.mts') as { triggerStore: () => TriggerStore }).triggerStore(),
        open: (cipher) => endpoints().defaultEndpointDeps().open(cipher),
        take: defaultTake,
        fire: () => defaultFireDeps(),
        now: () => Date.now(),
        limits: () => webhookLimits(),
        newDeliveryId: () => `whd_${randomBytes(16).toString('hex')}`,
        log: nodeRequire('../../../telemetry/log') as ReceiveDeps['log'],
    };
}

// ── Reading the request (plain loops: this is request text) ─────────────────────────────────

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-';

export function isNonce(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128) return false;
    for (const ch of value) if (!NONCE_CHARS.includes(ch)) return false;
    return true;
}

/** Unix seconds as sent: 1 to 12 digits. Null for anything else. */
export function readTimestamp(value: unknown): number | null {
    if (typeof value !== 'string' || value.length < 1 || value.length > 12) return null;
    for (const ch of value) if (ch < '0' || ch > '9') return null;
    return Number(value);
}

/** How deep a JSON value nests (a scalar is 0, {} is 1), stopping once it passes `max`. */
export function jsonDepth(value: unknown, max: number): number {
    let deepest = 0;
    const stack: Array<[unknown, number]> = [[value, 0]];
    while (stack.length) {
        const [v, above] = stack.pop() as [unknown, number];
        if (v === null || typeof v !== 'object') continue;
        const depth = above + 1;
        if (depth > deepest) deepest = depth;
        if (deepest > max) return deepest;
        for (const child of Array.isArray(v) ? v : Object.values(v as Obj)) stack.push([child, depth]);
    }
    return deepest;
}

/** The request headers a run may read, by their names in snake_case. Never the signature, the delivery id or an address. */
export const HEADER_ALLOW_LIST: readonly string[] = Object.freeze(['content-type', 'user-agent', 'x-request-id', 'x-beeflow-event']);
const MAX_HEADER_VALUE = 256;

export function pickHeaders(headers: Delivery['headers']): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of HEADER_ALLOW_LIST) {
        const raw = headers[name];
        const value = Array.isArray(raw) ? raw.join(', ') : raw;
        if (typeof value === 'string' && value) out[name.split('-').join('_')] = value.slice(0, MAX_HEADER_VALUE);
    }
    return out;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

// ── The checks ──────────────────────────────────────────────────────────────────────────────

/** A key no caller knows: an unknown address is signed against it, so it costs what a known one costs. */
const DECOY_SECRET = randomBytes(32).toString('hex');

/** Does the signature fit the endpoint's secret, or the previous one while its overlap lasts? */
function signedBy(endpoint: WebhookEndpoint | null, d: Delivery, deps: ReceiveDeps, now: number): boolean {
    const message = `${d.nonce}\n${d.timestamp}\n${d.rawBody.toString('utf8')}`;
    const secrets: string[] = [];
    if (endpoint) {
        const current = deps.open(endpoint.secretCipher);
        if (current) secrets.push(current);
        if (endpoint.prevSecretCipher && endpoint.prevValidUntil && Date.parse(endpoint.prevValidUntil) > now) {
            const previous = deps.open(endpoint.prevSecretCipher);
            if (previous) secrets.push(previous);
        }
    }
    let ok = false;
    // Every candidate is compared, and an unknown address still does one compare.
    for (const secret of secrets.length ? secrets : [DECOY_SECRET]) {
        if (deps.same(d.signature, deps.sign(secret, message)) && secrets.length > 0) ok = true;
    }
    return ok;
}

const refusedLog = new Map<string, { minute: number; count: number }>();
/** Test-only: forget how many refused deliveries were logged this minute. */
export const _resetRefusedLog = (): void => refusedLog.clear();

/** Write a refused delivery to the log, at most the operator's number per trigger per minute. */
async function logRefused(endpoint: WebhookEndpoint, status: DeliveryStatus, d: Delivery, deps: ReceiveDeps, now: number): Promise<void> {
    const max = deps.limits().rejectLogPerMinute;
    const minute = Math.floor(now / 60_000);
    const seen = refusedLog.get(endpoint.endpointId);
    const count = seen && seen.minute === minute ? seen.count + 1 : 1;
    refusedLog.set(endpoint.endpointId, { minute, count });
    if (max && count > max) return;
    try {
        await deps.store().logRefused({ id: deps.newDeliveryId(), endpointId: endpoint.endpointId, status, bodyBytes: d.rawBody.length, nowMs: now });
    } catch (e) {
        deps.log.warn(`[StudioWebhook] app=${endpoint.appId} trigger=${endpoint.triggerId} could not log a refused delivery (${(e as Error)?.name || 'error'})`);
    }
}

async function armedRow(endpoint: WebhookEndpoint, deps: ReceiveDeps): Promise<TriggerRow | null> {
    const row = (await deps.triggers().listForApp(endpoint.appId)).find((r) => r.triggerId === endpoint.triggerId);
    return row && row.kind === WEBHOOK_KIND && row.state === 'armed' ? row : null;
}

/**
 * The trigger's last run ended but the job has not looked yet: write how it ended now, so the
 * next delivery does not wait for the job's next pass. Answers the row as it is afterwards.
 */
async function settled(row: TriggerRow, endpoint: WebhookEndpoint, deps: ReceiveDeps, fire: FireDeps): Promise<TriggerRow | null> {
    if (row.lastStatus !== 'running' || !row.lastRunId) return row;
    const outcome = settleOutcome(row, await fire.getRun(row.lastRunId), fire.now(), fire.limits(), fire.cleanError);
    if (!outcome) return row;
    await deps.triggers().settle(row, outcome);
    return armedRow(endpoint, deps);
}

function readBody(d: Delivery, limits: WebhookLimits): { body: unknown } | { code: string; error: string } {
    let body: unknown;
    try {
        body = JSON.parse(d.rawBody.toString('utf8'));
    } catch {
        return { code: 'invalid_json', error: 'The body is not JSON.' };
    }
    if (body === null || typeof body !== 'object') return { code: 'invalid_body', error: 'The body is a JSON object or list.' };
    if (limits.bodyMaxDepth && jsonDepth(body, limits.bodyMaxDepth) > limits.bodyMaxDepth) {
        return { code: 'body_too_deep', error: `The body nests deeper than ${limits.bodyMaxDepth} levels.` };
    }
    return { body };
}

const busy = (error: string, retryAfterSecs = BUSY_RETRY_SECS): ReceiveResult => ({ status: 429, code: 'busy', error, retryAfterSecs });

/** Start the run of a claimed delivery, and write what became of it. */
async function start(row: TriggerRow, endpoint: WebhookEndpoint, deliveryId: string, body: unknown, d: Delivery, deps: ReceiveDeps, now: number): Promise<ReceiveResult> {
    const fire = deps.fire();
    const store = deps.store();
    const release = (status: DeliveryStatus) => store.finishDelivery(deliveryId, { status, release: true });
    let outcome: Awaited<ReturnType<typeof fireTrigger>>;
    try {
        const ready = await settled(row, endpoint, deps, fire);
        if (!ready) {
            await release('disarmed');
            return NOT_FOUND;
        }
        const scope = triggerScope(WEBHOOK_KIND, { body, headers: pickHeaders(d.headers), deliveryId, receivedAt: new Date(now).toISOString() });
        outcome = await fireTrigger(ready, fire, scope);
    } catch (e) {
        await release('busy');
        deps.log.warn(`[StudioWebhook] app=${endpoint.appId} trigger=${endpoint.triggerId} delivery=${deliveryId} could not start (${(e as Error)?.name || 'error'})`);
        return busy('The delivery could not be started. Send it again.');
    }
    if (outcome === 'disarmed') {
        await release('disarmed');
        return NOT_FOUND;
    }
    if (outcome !== 'fired') {
        await release('busy');
        return busy(outcome === 'lost' ? 'A run of this trigger is still going. Send the delivery again in a moment.' : 'The delivery was not started. Send it again later.');
    }
    const after = (await deps.triggers().listForApp(endpoint.appId)).find((r) => r.triggerId === endpoint.triggerId);
    await store.finishDelivery(deliveryId, { status: 'accepted', runId: after?.lastRunId ?? null });
    deps.log.info(`[StudioWebhook] app=${endpoint.appId} trigger=${endpoint.triggerId} delivery=${deliveryId} accepted`);
    return { status: 202, body: { accepted: true, deliveryId } };
}

/** One delivery, by the order in the header. */
export async function receiveWebhook(d: Delivery, deps: ReceiveDeps): Promise<ReceiveResult> {
    const now = deps.now();
    const limits = deps.limits();
    const store = deps.store();
    const endpoint = isEndpointId(d.endpointId) ? await store.endpointById(d.endpointId) : null;
    const stamp = readTimestamp(d.timestamp);
    const wellFormed = isNonce(d.nonce) && stamp !== null && d.signature.startsWith('sha256=');
    const signed = signedBy(endpoint, d, deps, now) && wellFormed;
    if (!endpoint) return NOT_FOUND;
    if (!signed) {
        await logRefused(endpoint, 'bad_signature', d, deps, now);
        return NOT_FOUND;
    }
    if (Math.abs(Math.floor(now / 1000) - (stamp as number)) > limits.toleranceSeconds) {
        await logRefused(endpoint, 'stale_timestamp', d, deps, now);
        return NOT_FOUND;
    }
    const row = await armedRow(endpoint, deps);
    if (!row) {
        await logRefused(endpoint, 'disarmed', d, deps, now);
        return NOT_FOUND;
    }
    const taken = await deps.take(endpoint.endpointId, limits.rpmPerTrigger);
    if (!taken.ok) {
        await logRefused(endpoint, 'rate_limited', d, deps, now);
        return { status: 429, code: 'rate_limited', error: 'This trigger takes no more deliveries this minute.', retryAfterSecs: taken.retryAfterSecs };
    }
    const read = readBody(d, limits);
    if ('code' in read) {
        await logRefused(endpoint, 'invalid_body', d, deps, now);
        return { status: 400, code: read.code, error: read.error };
    }
    const deliveryId = deps.newDeliveryId();
    const claim = await store.claimDelivery({
        id: deliveryId, endpointId: endpoint.endpointId, nonceHash: sha256(d.nonce), bodyBytes: d.rawBody.length, bodySha256: sha256(d.rawBody), nowMs: now, staleMs: CLAIM_STALE_MS,
    });
    if (!claim.claimed) {
        // The same delivery again: the first one's answer, and nothing starts.
        if (claim.existing?.status === 'accepted') {
            await logRefused(endpoint, 'replay', d, deps, now);
            return { status: 202, body: { accepted: true, deliveryId: claim.existing.id, duplicate: true } };
        }
        return busy('This delivery is being started. Send it again in a moment.', 2);
    }
    const result = await start(row, endpoint, deliveryId, read.body, d, deps, now);
    if (limits.deliveryLogMax) {
        try { await store.pruneEndpoint(endpoint.endpointId, { keep: limits.deliveryLogMax, nowMs: now, protectMs: limits.toleranceSeconds * 2000 }); } catch { /* the retention job prunes too */ }
    }
    return result;
}

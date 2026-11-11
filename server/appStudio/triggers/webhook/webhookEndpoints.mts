/**
 * The address and the secret of a webhook trigger, and what its owner reads about it.
 *
 * WHEN AN ENDPOINT EXISTS. A webhook trigger gets its endpoint when the app is PUBLISHED with
 * the trigger in it (syncWebhookEndpoints, called by the publish route after the triggers were
 * armed). It keeps the endpoint through every later publish that still holds the trigger, so
 * the address a sender was given does not change when the action is edited. A publish without
 * the trigger removes the endpoint and its delivery log. An unpublish keeps it: nothing is
 * accepted while the app is unpublished (the armed row is gone, webhookReceive.mts asks at every
 * delivery), and publishing again brings the same address back. A deleted app takes its
 * endpoints with it (ON DELETE CASCADE).
 *
 * THE SECRET. 256 random bits, made here, sealed before it is stored (stores/configEncryption.js,
 * under the app's organisation) and never written to a log, a definition, a run or a tool result.
 * The owner is shown it ONCE (revealWebhookSecret); after that the only way to hold a secret is
 * to rotate (rotateWebhookSecret), which shows the new one once. After a rotation the previous
 * secret still signs for STUDIO_APP_WEBHOOK_ROTATION_OVERLAP_SECONDS, so a sender can be moved
 * over without a gap; 0 ends it at once.
 *
 * Owner only: the routes (routes/studioApps/triggers.js) gate on the app's owner before they
 * call anything here.
 */

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { WebhookDelivery, WebhookTriggerStore } from '../../../stores/studioAppData/webhookTriggers.mts';
import { webhookLimits } from '../../../stores/studioAppData/webhookPolicy.mts';
import type { WebhookLimits } from '../../../stores/studioAppData/webhookPolicy.mts';
import { readTriggers } from '../triggerSpec.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

type AppRow = { id: string; userId: string; organizationId?: string | null; isPublished?: boolean; publishedDefinition?: Obj | null };

export const WEBHOOK_KIND = 'webhook';
export const WEBHOOK_PATH = '/api/app-hooks';
export const SIGNATURE_HEADER = 'X-BeeFlow-Signature';
export const TIMESTAMP_HEADER = 'X-BeeFlow-Timestamp';
export const NONCE_HEADER = 'X-BeeFlow-Nonce';
/** Deliveries the owner's panel shows. */
export const DELIVERIES_SHOWN = 20;

const HEX = '0123456789abcdef';

/** An endpoint id: 48 lower-case hex characters. */
export function isEndpointId(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 48) return false;
    for (const ch of value) if (!HEX.includes(ch)) return false;
    return true;
}

export type EndpointDeps = {
    store: () => WebhookTriggerStore;
    getApp: (appId: string) => Promise<AppRow | null>;
    /** Seal a secret for storage, under the organisation of the app. */
    seal: (secret: string, orgId: string | null) => string;
    /** A sealed secret in clear, or null when it cannot be read. */
    open: (cipher: string) => string | null;
    newEndpointId: () => string;
    newSecret: () => string;
    now: () => number;
    limits: () => WebhookLimits;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
};

type Crypto = { encryptValue: (plain: string, orgId?: string | null) => string; decryptValue: (stored: string) => string | null };

export function defaultEndpointDeps(): EndpointDeps {
    const crypto = (): Crypto => nodeRequire('../../../stores/configEncryption.js') as Crypto;
    return {
        store: () => (nodeRequire('../../../stores/studioAppData/webhookTriggers.mts') as { webhookTriggerStore: () => WebhookTriggerStore }).webhookTriggerStore(),
        getApp: (appId) => (nodeRequire('../../../stores/studioAppStore') as { getStudioApp: EndpointDeps['getApp'] }).getStudioApp(appId),
        seal: (secret, orgId) => crypto().encryptValue(secret, orgId),
        open: (cipher) => {
            const plain = crypto().decryptValue(cipher);
            // decryptValue hands a value that is no envelope back as it is: a sealed column never holds one.
            return typeof plain === 'string' && plain && plain !== cipher ? plain : null;
        },
        newEndpointId: () => randomBytes(24).toString('hex'),
        newSecret: () => randomBytes(32).toString('hex'),
        now: () => Date.now(),
        limits: () => webhookLimits(),
        log: nodeRequire('../../../telemetry/log') as EndpointDeps['log'],
    };
}

/** The ids of the webhook triggers a definition holds (switched on or not). */
export function webhookTriggerIds(def: unknown): string[] {
    return readTriggers(def).filter((t) => t.kind === WEBHOOK_KIND).map((t) => t.id);
}

/**
 * Give every webhook trigger of the published app its endpoint and remove the endpoints of
 * triggers that left it. Never throws: the publish that called it has already happened. Null
 * when it failed; the endpoints are then as they were.
 */
export async function syncWebhookEndpoints(appId: string, given: Partial<EndpointDeps> = {}): Promise<{ created: number; removed: number } | null> {
    const deps = { ...defaultEndpointDeps(), ...given };
    try {
        const app = await deps.getApp(appId);
        if (!app || !app.isPublished || !isObject(app.publishedDefinition)) return { created: 0, removed: 0 };
        const store = deps.store();
        const ids = webhookTriggerIds(app.publishedDefinition);
        let created = 0;
        for (const triggerId of ids) {
            const fresh = { endpointId: deps.newEndpointId(), secretCipher: deps.seal(deps.newSecret(), app.organizationId || null) };
            if (await store.ensureEndpoint(app.id, triggerId, fresh)) created += 1;
        }
        const removed = await store.keepEndpoints(app.id, ids);
        if (created || removed) deps.log.info(`[StudioWebhook] app=${app.id} endpoints: ${created} made, ${removed} removed`);
        return { created, removed };
    } catch (e) {
        deps.log.warn(`[StudioWebhook] app=${appId} could not sync its webhook endpoints (${(e as Error)?.name || 'error'})`);
        return null;
    }
}

export type WebhookView = {
    endpoint: null | {
        /** The path of the address; the route puts the server's public origin before it. */
        path: string;
        /** The secret was not shown yet: it can be asked for once. */
        secretAvailable: boolean;
        createdAt: string | null; rotatedAt: string | null;
        /** Until when the secret from before the last rotation still signs; null when it no longer does. */
        previousValidUntil: string | null;
    };
    signing: { signatureHeader: string; timestampHeader: string; nonceHeader: string; toleranceSeconds: number; maxBodyBytes: number };
    deliveries: WebhookDelivery[];
};

/** A short form of the body hash: enough for the owner to tell two deliveries apart. */
const shortHash = (d: WebhookDelivery): WebhookDelivery => ({ ...d, bodyHash: d.bodyHash ? d.bodyHash.slice(0, 12) : null });

/** What the owner's panel shows of one webhook trigger. Never the secret. */
export async function webhookView(app: { id: string }, triggerId: string, given: Partial<EndpointDeps> = {}): Promise<WebhookView> {
    const deps = { ...defaultEndpointDeps(), ...given };
    const limits = deps.limits();
    const signing = { signatureHeader: SIGNATURE_HEADER, timestampHeader: TIMESTAMP_HEADER, nonceHeader: NONCE_HEADER, toleranceSeconds: limits.toleranceSeconds, maxBodyBytes: limits.bodyMaxBytes };
    const row = await deps.store().endpointFor(app.id, triggerId);
    if (!row) return { endpoint: null, signing, deliveries: [] };
    const overlap = row.prevSecretCipher && row.prevValidUntil && Date.parse(row.prevValidUntil) > deps.now() ? row.prevValidUntil : null;
    return {
        endpoint: { path: `${WEBHOOK_PATH}/${row.endpointId}`, secretAvailable: row.secretShownAt === null, createdAt: row.createdAt, rotatedAt: row.rotatedAt, previousValidUntil: overlap },
        signing,
        deliveries: (await deps.store().listDeliveries(row.endpointId, DELIVERIES_SHOWN)).map(shortHash),
    };
}

export type SecretResult = { ok: true; secret: string; previousValidUntil: string | null } | { ok: false; status: number; code: string; error: string };

const NO_ENDPOINT: SecretResult = { ok: false, status: 409, code: 'no_endpoint', error: 'This trigger has no address yet. Publish the app to give it one.' };

/** The secret, the one time it is shown. */
export async function revealWebhookSecret(app: { id: string }, triggerId: string, given: Partial<EndpointDeps> = {}): Promise<SecretResult> {
    const deps = { ...defaultEndpointDeps(), ...given };
    const store = deps.store();
    if (!(await store.endpointFor(app.id, triggerId))) return NO_ENDPOINT;
    const cipher = await store.takeSecretOnce(app.id, triggerId, deps.now());
    if (!cipher) return { ok: false, status: 409, code: 'secret_shown', error: 'The secret was already shown. Rotate it to get a new one.' };
    const secret = deps.open(cipher);
    if (!secret) return { ok: false, status: 409, code: 'secret_unreadable', error: 'The stored secret could not be read. Rotate it to get a new one.' };
    return { ok: true, secret, previousValidUntil: null };
}

/** A new secret, shown once. The previous one keeps signing for the overlap. */
export async function rotateWebhookSecret(app: { id: string; organizationId?: string | null }, triggerId: string, given: Partial<EndpointDeps> = {}): Promise<SecretResult> {
    const deps = { ...defaultEndpointDeps(), ...given };
    const secret = deps.newSecret();
    const now = deps.now();
    const overlap = deps.limits().rotationOverlapSeconds;
    const row = await deps.store().rotateSecret(app.id, triggerId, {
        secretCipher: deps.seal(secret, app.organizationId || null), nowMs: now, prevValidUntilMs: overlap ? now + overlap * 1000 : null,
    });
    if (!row) return NO_ENDPOINT;
    deps.log.info(`[StudioWebhook] app=${app.id} trigger=${triggerId} secret rotated`);
    return { ok: true, secret, previousValidUntil: row.prevValidUntil };
}

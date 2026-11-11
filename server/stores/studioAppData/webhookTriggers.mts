/**
 * stores/studioAppData/webhookTriggers.mts: the endpoints and the delivery log of webhook
 * triggers (studio_app_webhook_endpoints, studio_app_webhook_deliveries; DDL in ./schema.js).
 * The rules are in appStudio/triggers/webhook/; this file only reads and writes.
 *
 *   ensureEndpoint     the endpoint of (app, trigger), created when there is none; an existing one
 *                      keeps its address and its secret
 *   keepEndpoints      remove every endpoint of the app whose trigger is not in the list
 *   endpointById       the endpoint an inbound address names
 *   endpointFor        the endpoint of (app, trigger), for the owner
 *   takeSecretOnce     the sealed secret, the first time it is asked for; null ever after
 *   rotateSecret       a new sealed secret; the one before stays valid until `prevValidUntil`
 *   claimDelivery      a signed delivery, by the hash of its delivery id: of two that arrive at
 *                      once one gets it; the other is told what became of the first
 *   finishDelivery     what became of a claimed delivery; `release` frees its delivery id so the
 *                      sender's retry is taken as a new one
 *   logRefused         a delivery that was refused (it holds no delivery id)
 *   listDeliveries     the newest deliveries of an endpoint
 *   pruneEndpoint      keep the newest N of one endpoint
 *   pruneOld           delete deliveries older than the retention, everywhere
 *
 * The columns that need a word:
 *   endpoint_id         the opaque id in the address (192 random bits); an address, not a secret
 *   secret_cipher       the signing secret, sealed (stores/configEncryption.js)
 *   prev_secret_cipher  the secret before the last rotation, accepted until prev_valid_until
 *   secret_shown_at     when the owner was shown the secret; it is shown once
 *   nonce_hash          sha256 of the sender's delivery id, unique per endpoint, so a delivery that
 *                       is sent again starts nothing; NULL on a delivery that was refused
 * A delivery row holds no body, no header and no address of the sender: the size and a hash only.
 *
 * The secret arrives and leaves SEALED; this file never sees it in clear. Times go in as epoch
 * milliseconds and "now" is the caller's clock, so a test with a fake clock reads the same code.
 */

import { createRequire } from 'node:module';

import type { Queryable, RunDb } from './actionRuns.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type QueryResult = Awaited<ReturnType<Queryable['query']>>;

export type WebhookEndpoint = {
    endpointId: string; appId: string; triggerId: string;
    secretCipher: string; prevSecretCipher: string | null; prevValidUntil: string | null;
    secretShownAt: string | null; rotatedAt: string | null; createdAt: string | null;
};

export type DeliveryStatus = 'received' | 'accepted' | 'bad_signature' | 'stale_timestamp' | 'replay' | 'rate_limited' | 'disarmed' | 'busy' | 'invalid_body';

export type WebhookDelivery = { id: string; status: string; bodyBytes: number; bodyHash: string | null; runId: string | null; receivedAt: string | null };

export type Claim = { claimed: true } | { claimed: false; existing: { id: string; status: string } | null };

const changed = (r: QueryResult): number => r.rowCount ?? r.affectedRows ?? 0;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** Epoch ms as a timestamp parameter (NULL stays NULL). */
const TS = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;

function toEndpoint(row: Row): WebhookEndpoint {
    return {
        endpointId: String(row.endpoint_id), appId: String(row.app_id), triggerId: String(row.trigger_id),
        secretCipher: String(row.secret_cipher), prevSecretCipher: text(row.prev_secret_cipher), prevValidUntil: iso(row.prev_valid_until),
        secretShownAt: iso(row.secret_shown_at), rotatedAt: iso(row.rotated_at), createdAt: iso(row.created_at),
    };
}

function toDelivery(row: Row): WebhookDelivery {
    return {
        id: String(row.id), status: String(row.status), bodyBytes: Number(row.body_bytes ?? 0), bodyHash: text(row.body_sha256),
        runId: text(row.run_id), receivedAt: iso(row.received_at),
    };
}

export function makeWebhookTriggerStore(db: RunDb, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    /** True when the endpoint was created by this call. */
    async function ensureEndpoint(appId: string, triggerId: string, fresh: { endpointId: string; secretCipher: string }): Promise<boolean> {
        await ready();
        return changed(await db.query(
            `INSERT INTO studio_app_webhook_endpoints (endpoint_id, app_id, trigger_id, secret_cipher)
             VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, trigger_id) DO NOTHING`,
            [fresh.endpointId, appId, triggerId, fresh.secretCipher],
        )) > 0;
    }

    /** Remove the app's endpoints whose trigger is not one of `triggerIds`. Their deliveries go with them. */
    async function keepEndpoints(appId: string, triggerIds: string[]): Promise<number> {
        await ready();
        return changed(await db.query(
            'DELETE FROM studio_app_webhook_endpoints WHERE app_id = $1 AND NOT (trigger_id = ANY($2::text[]))',
            [appId, triggerIds],
        ));
    }

    async function endpointById(endpointId: string): Promise<WebhookEndpoint | null> {
        await ready();
        const { rows } = await db.query('SELECT * FROM studio_app_webhook_endpoints WHERE endpoint_id = $1', [endpointId]);
        return rows[0] ? toEndpoint(rows[0]) : null;
    }

    async function endpointFor(appId: string, triggerId: string): Promise<WebhookEndpoint | null> {
        await ready();
        const { rows } = await db.query('SELECT * FROM studio_app_webhook_endpoints WHERE app_id = $1 AND trigger_id = $2', [appId, triggerId]);
        return rows[0] ? toEndpoint(rows[0]) : null;
    }

    /** The sealed secret for the one caller that asks first; null when it was shown before (or there is no endpoint). */
    async function takeSecretOnce(appId: string, triggerId: string, nowMs: number): Promise<string | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_webhook_endpoints SET secret_shown_at = ${TS('$3')}
              WHERE app_id = $1 AND trigger_id = $2 AND secret_shown_at IS NULL RETURNING secret_cipher`,
            [appId, triggerId, nowMs],
        );
        return rows[0] ? String(rows[0].secret_cipher) : null;
    }

    /**
     * Replace the secret. The one before moves to the `prev` columns until `prevValidUntilMs`
     * (null: it stops at once). The new one counts as shown: the caller hands it out now.
     */
    async function rotateSecret(appId: string, triggerId: string, next: { secretCipher: string; nowMs: number; prevValidUntilMs: number | null }): Promise<WebhookEndpoint | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_webhook_endpoints
                SET prev_secret_cipher = CASE WHEN $5::double precision IS NULL THEN NULL ELSE secret_cipher END,
                    prev_valid_until = ${TS('$5')}, secret_cipher = $3, rotated_at = ${TS('$4')}, secret_shown_at = ${TS('$4')}
              WHERE app_id = $1 AND trigger_id = $2 RETURNING *`,
            [appId, triggerId, next.secretCipher, next.nowMs, next.prevValidUntilMs],
        );
        return rows[0] ? toEndpoint(rows[0]) : null;
    }

    /**
     * Take a signed delivery. One row per (endpoint, delivery id) exists at a time, so of two
     * identical deliveries that arrive together one is claimed and the other reads the first.
     * A claim that was never finished (the process died between the claim and the start) is
     * taken over after `staleMs`.
     */
    async function claimDelivery(d: { id: string; endpointId: string; nonceHash: string; bodyBytes: number; bodySha256: string; nowMs: number; staleMs: number }): Promise<Claim> {
        await ready();
        const { rows } = await db.query(
            `INSERT INTO studio_app_webhook_deliveries (id, endpoint_id, status, nonce_hash, body_bytes, body_sha256, received_at)
             VALUES ($1, $2, 'received', $3, $4, $5, ${TS('$6')})
             ON CONFLICT (endpoint_id, nonce_hash) WHERE nonce_hash IS NOT NULL DO UPDATE
                SET id = EXCLUDED.id, body_bytes = EXCLUDED.body_bytes, body_sha256 = EXCLUDED.body_sha256, received_at = EXCLUDED.received_at
              WHERE studio_app_webhook_deliveries.status = 'received'
                AND studio_app_webhook_deliveries.received_at < ${TS('$7')}
          RETURNING id`,
            [d.id, d.endpointId, d.nonceHash, d.bodyBytes, d.bodySha256, d.nowMs, d.nowMs - d.staleMs],
        );
        if (rows[0]) return { claimed: true };
        const seen = await db.query('SELECT id, status FROM studio_app_webhook_deliveries WHERE endpoint_id = $1 AND nonce_hash = $2', [d.endpointId, d.nonceHash]);
        const row = seen.rows[0];
        return { claimed: false, existing: row ? { id: String(row.id), status: String(row.status) } : null };
    }

    async function finishDelivery(id: string, end: { status: DeliveryStatus; runId?: string | null; release?: boolean }): Promise<void> {
        await ready();
        await db.query(
            `UPDATE studio_app_webhook_deliveries
                SET status = $2, run_id = $3, nonce_hash = CASE WHEN $4::boolean THEN NULL ELSE nonce_hash END
              WHERE id = $1`,
            [id, end.status, end.runId ?? null, end.release === true],
        );
    }

    async function logRefused(d: { id: string; endpointId: string; status: DeliveryStatus; bodyBytes: number; bodySha256?: string | null; nowMs: number }): Promise<void> {
        await ready();
        await db.query(
            `INSERT INTO studio_app_webhook_deliveries (id, endpoint_id, status, body_bytes, body_sha256, received_at)
             VALUES ($1, $2, $3, $4, $5, ${TS('$6')})`,
            [d.id, d.endpointId, d.status, d.bodyBytes, d.bodySha256 ?? null, d.nowMs],
        );
    }

    async function listDeliveries(endpointId: string, limit: number): Promise<WebhookDelivery[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT id, status, body_bytes, body_sha256, run_id, received_at FROM studio_app_webhook_deliveries
              WHERE endpoint_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2`,
            [endpointId, Math.max(1, Math.floor(limit))],
        );
        return rows.map(toDelivery);
    }

    /**
     * Keep the newest `keep` deliveries of one endpoint. A row younger than `protectMs` stays
     * whatever the count: its delivery id is what refuses the same delivery a second time.
     */
    async function pruneEndpoint(endpointId: string, p: { keep: number; nowMs: number; protectMs: number }): Promise<number> {
        await ready();
        if (p.keep <= 0) return 0;
        return changed(await db.query(
            `DELETE FROM studio_app_webhook_deliveries
              WHERE endpoint_id = $1 AND received_at < ${TS('$3')}
                AND id IN (SELECT id FROM studio_app_webhook_deliveries WHERE endpoint_id = $1
                            ORDER BY received_at DESC, id DESC OFFSET $2)`,
            [endpointId, Math.floor(p.keep), p.nowMs - p.protectMs],
        ));
    }

    /** Delete deliveries older than `olderThanMs` (the database's clock: this is the retention job). */
    async function pruneOld(olderThanMs: number): Promise<number> {
        await ready();
        if (olderThanMs <= 0) return 0;
        return changed(await db.query(
            `DELETE FROM studio_app_webhook_deliveries WHERE received_at < NOW() - make_interval(secs => $1::double precision / 1000)`,
            [olderThanMs],
        ));
    }

    return { ensureEndpoint, keepEndpoints, endpointById, endpointFor, takeSecretOnce, rotateSecret, claimDelivery, finishDelivery, logRefused, listDeliveries, pruneEndpoint, pruneOld };
}

export type WebhookTriggerStore = ReturnType<typeof makeWebhookTriggerStore>;

let singleton: WebhookTriggerStore | null = null;

/** The store over the app's database, created on first use (awaits the data store's init). */
export function webhookTriggerStore(): WebhookTriggerStore {
    if (!singleton) {
        const dbMod = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<QueryResult>; withTransaction: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T> };
        singleton = makeWebhookTriggerStore(
            { query: (sql, params) => dbMod.run(sql, params), tx: (fn) => dbMod.withTransaction(fn) },
            { ready: () => (nodeRequire('./schema') as { initDB: () => Promise<unknown> }).initDB() },
        );
    }
    return singleton;
}

/** The retention job's pass (jobs/platformRetention.js): deliveries older than the retention, never one still inside the timestamp window. */
export async function pruneWebhookDeliveries(env: Record<string, string | undefined> = process.env): Promise<number> {
    const { webhookLimits } = nodeRequire('./webhookPolicy.mts') as typeof import('./webhookPolicy.mts');
    const limits = webhookLimits(env);
    if (!limits.deliveryRetentionDays) return 0;
    return webhookTriggerStore().pruneOld(Math.max(limits.deliveryRetentionDays * 86_400_000, limits.toleranceSeconds * 2000));
}

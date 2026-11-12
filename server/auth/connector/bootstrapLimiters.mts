/**
 * Nextcloud connector: the per-IP rate limits of the unauthenticated
 * bootstrap routes (auth/connectorBootstrap.js).
 *
 * Bootstrap is unauthenticated by design (the connector has no Bee Flow
 * credentials at that point), so each route is limited per source IP: enough
 * for a real fleet rollout (several Nextclouds behind one NAT), little enough
 * to keep repeated unauthenticated calls cheap to absorb. The server resolves
 * req.ip from X-Forwarded-For (app.set('trust proxy')); `validate: {
 * trustProxy: false }` silences express-rate-limit's strict check of that.
 *
 *   CONNECTOR_BOOTSTRAP_RATE_LIMIT  bootstrap and diagnose calls per IP per
 *                                   15 minutes (default 20, 0 = unlimited)
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown, next: () => void) => void;
const rateLimit = nodeRequire('express-rate-limit') as (opts: Record<string, unknown>) => Handler;

/** CONNECTOR_BOOTSTRAP_RATE_LIMIT, default 20; 0 = unlimited. */
export function bootstrapRateLimit(): number {
    const n = Number.parseInt(String(process.env.CONNECTOR_BOOTSTRAP_RATE_LIMIT ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : 20;
}

const common = { standardHeaders: true, legacyHeaders: false, validate: { trustProxy: false } };

/** Bootstrap and diagnose: each makes this server call the Nextcloud the caller names. */
export const bootstrapLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60_000,
    // express-rate-limit 7+ blocks everything at 0, so 0 skips the limiter instead.
    max: bootstrapRateLimit() || 1,
    skip: () => bootstrapRateLimit() === 0,
    message: { error: 'Too many bootstrap attempts; try again later.' },
});

/** The pending-row poll and the code verification: the connector polls every few seconds. */
export const pendingPollLimiter = rateLimit({
    ...common,
    windowMs: 60_000,
    max: 60,
    message: { error: 'Too many poll requests.' },
});

/** Phone-home status reports: a heartbeat every few hours plus one report per failure episode. */
export const statusReportLimiter = rateLimit({
    ...common,
    windowMs: 60 * 60_000,
    max: 12,
    message: { error: 'Too many status reports; try again later.' },
});

/** Resend and retarget each e-mail a code: tight, so a held pending id cannot flood a mailbox. */
export const verificationResendLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60_000,
    max: 5,
    message: { error: 'Too many code requests; try again later.' },
});

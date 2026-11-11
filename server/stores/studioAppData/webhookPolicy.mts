/**
 * The operator's knobs of App Studio webhook triggers (appStudio/triggers/webhook/), beside the
 * store in the platform layer so the inbound route, the feature and the retention job
 * (jobs/platformRetention.js) read one copy. Read per call; 0 = unlimited unless said otherwise.
 *
 *   STUDIO_APP_WEBHOOK_BODY_MAX_BYTES            65536  the largest body of one delivery
 *   STUDIO_APP_WEBHOOK_BODY_MAX_DEPTH            20     how deep its JSON may nest
 *   STUDIO_APP_WEBHOOK_TOLERANCE_SECONDS         300    how far the sender's timestamp may be from the
 *                                                       server's clock (a window, not a cap: at least 30)
 *   STUDIO_APP_WEBHOOK_RPM_PER_TRIGGER           120    signed deliveries one trigger takes per minute
 *   STUDIO_APP_WEBHOOK_RPM_PER_IP                300    requests one address may send per minute
 *   STUDIO_APP_WEBHOOK_ROTATION_OVERLAP_SECONDS  3600   how long the previous secret still signs after
 *                                                       a rotation (0 = it stops at once)
 *   STUDIO_APP_WEBHOOK_DELIVERY_LOG_MAX          100    deliveries kept per trigger
 *   STUDIO_APP_WEBHOOK_DELIVERY_RETENTION_DAYS   30     deliveries older than this are deleted (0 = keep)
 *   STUDIO_APP_WEBHOOK_REJECT_LOG_PER_MINUTE     20     refused deliveries written to the log per
 *                                                       trigger per minute (the rest are only counted)
 */

export const WEBHOOK_ENV = Object.freeze({
    bodyMaxBytes: { env: 'STUDIO_APP_WEBHOOK_BODY_MAX_BYTES', fallback: 65_536 },
    bodyMaxDepth: { env: 'STUDIO_APP_WEBHOOK_BODY_MAX_DEPTH', fallback: 20 },
    toleranceSeconds: { env: 'STUDIO_APP_WEBHOOK_TOLERANCE_SECONDS', fallback: 300 },
    rpmPerTrigger: { env: 'STUDIO_APP_WEBHOOK_RPM_PER_TRIGGER', fallback: 120 },
    rpmPerIp: { env: 'STUDIO_APP_WEBHOOK_RPM_PER_IP', fallback: 300 },
    rotationOverlapSeconds: { env: 'STUDIO_APP_WEBHOOK_ROTATION_OVERLAP_SECONDS', fallback: 3600 },
    deliveryLogMax: { env: 'STUDIO_APP_WEBHOOK_DELIVERY_LOG_MAX', fallback: 100 },
    deliveryRetentionDays: { env: 'STUDIO_APP_WEBHOOK_DELIVERY_RETENTION_DAYS', fallback: 30 },
    rejectLogPerMinute: { env: 'STUDIO_APP_WEBHOOK_REJECT_LOG_PER_MINUTE', fallback: 20 },
});

export type WebhookLimits = { -readonly [K in keyof typeof WEBHOOK_ENV]: number };

/** The shortest timestamp window: under it a sender's ordinary clock drift would refuse real deliveries. */
export const MIN_TOLERANCE_SECONDS = 30;

function intFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function webhookLimits(env: Record<string, string | undefined> = process.env): WebhookLimits {
    const out = {} as WebhookLimits;
    for (const [key, { env: name, fallback }] of Object.entries(WEBHOOK_ENV)) out[key as keyof WebhookLimits] = intFromEnv(env, name, fallback);
    out.toleranceSeconds = Math.max(MIN_TOLERANCE_SECONDS, out.toleranceSeconds);
    return out;
}

/**
 * The operator's knobs of the automation webhook trigger (routes/automation/events.js), beside
 * the store so the inbound route, the store and the retention job read one copy. Read per call.
 * Unset, blank or not a number: the default. 0 = unlimited unless said otherwise.
 *
 *   AUTOMATION_WEBHOOK_RPM_PER_SLUG                  120   requests one webhook address takes per minute
 *   AUTOMATION_WEBHOOK_RPM_PER_IP                    300   requests one sender address may send per minute
 *   AUTOMATION_EVENTS_RPM_PER_IP                     600   provider event pushes one address may send per minute
 *   AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS      3600  how long the previous secret still signs after
 *                                                          a rotation (0 = it stops at once)
 *   AUTOMATION_WEBHOOK_DELIVERY_LOG_MAX              100   deliveries kept per webhook
 *   AUTOMATION_WEBHOOK_DELIVERY_RETENTION_DAYS       30    deliveries older than this are deleted (0 = keep)
 *   AUTOMATION_WEBHOOK_REJECT_LOG_PER_MINUTE         20    deliveries that started no run written to the log
 *                                                          per webhook per minute (the rest are not written)
 */

export const AUTOMATION_WEBHOOK_ENV = Object.freeze({
    rpmPerSlug: { env: 'AUTOMATION_WEBHOOK_RPM_PER_SLUG', fallback: 120 },
    rpmPerIp: { env: 'AUTOMATION_WEBHOOK_RPM_PER_IP', fallback: 300 },
    eventsRpmPerIp: { env: 'AUTOMATION_EVENTS_RPM_PER_IP', fallback: 600 },
    rotationOverlapSeconds: { env: 'AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS', fallback: 3600 },
    deliveryLogMax: { env: 'AUTOMATION_WEBHOOK_DELIVERY_LOG_MAX', fallback: 100 },
    deliveryRetentionDays: { env: 'AUTOMATION_WEBHOOK_DELIVERY_RETENTION_DAYS', fallback: 30 },
    rejectLogPerMinute: { env: 'AUTOMATION_WEBHOOK_REJECT_LOG_PER_MINUTE', fallback: 20 },
});

export type AutomationWebhookLimits = { -readonly [K in keyof typeof AUTOMATION_WEBHOOK_ENV]: number };

function intFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function automationWebhookLimits(env: Record<string, string | undefined> = process.env): AutomationWebhookLimits {
    const out = {} as AutomationWebhookLimits;
    for (const [key, { env: name, fallback }] of Object.entries(AUTOMATION_WEBHOOK_ENV)) out[key as keyof AutomationWebhookLimits] = intFromEnv(env, name, fallback);
    return out;
}

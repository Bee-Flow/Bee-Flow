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
 */

export const AUTOMATION_WEBHOOK_ENV = Object.freeze({
    rpmPerSlug: { env: 'AUTOMATION_WEBHOOK_RPM_PER_SLUG', fallback: 120 },
    rpmPerIp: { env: 'AUTOMATION_WEBHOOK_RPM_PER_IP', fallback: 300 },
    eventsRpmPerIp: { env: 'AUTOMATION_EVENTS_RPM_PER_IP', fallback: 600 },
    rotationOverlapSeconds: { env: 'AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS', fallback: 3600 },
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

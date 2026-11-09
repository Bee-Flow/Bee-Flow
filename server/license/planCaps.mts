/**
 * Whether a subscription plan's resource caps (max_users, max_agents,
 * max_knowledge_sources) apply on this install.
 *
 * Only on Bee Flow Cloud: there each organisation pays for its own plan. On a
 * self-hosted install the server licence governs every organisation and plans
 * are never consulted, yet an organisation can still carry a subscription row
 * (Nextcloud provisioning assigns one, or the install once ran as cloud). Its
 * Free-plan caps must not cap a self-hosted organisation. A licence seat cap
 * (license/seats.js) is not a plan cap and keeps applying everywhere.
 *
 * No imports: the user store reads this inside its seat check, and importing
 * license/index.js from there would close an import cycle.
 */

export function planResourceCapsApply(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
}

/** The plan's cap for `field`, or null when there is none or plan caps do not apply here. */
export function planCap(limits: object | null | undefined, field: string): number | null {
    if (!limits || !planResourceCapsApply()) return null;
    return ((limits as Record<string, unknown>)[field] as number | null | undefined) ?? null;
}

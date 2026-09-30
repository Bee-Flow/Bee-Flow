/**
 * A webhook trigger's endpoint, pure — from agent-hub
 * `Builder/webhooks/useWebhooks.js`: which of the routine's webhook URLs
 * belong to THIS trigger node, the signed cURL command that exercises one,
 * and the secret masked for the screen. Pinned by trigger.lockstep.test.ts.
 */

import type { FlowWebhook } from '@/features/flow-editor/api';

/**
 * The URLs of one trigger node. A webhook created before per-node scoping
 * carries no `triggerStepId`; it belongs to the PRIMARY trigger.
 */
export function webhooksFor(rows: readonly FlowWebhook[], stepId: string | null, primaryId: string | null | undefined): FlowWebhook[] {
    if (!stepId) return rows.slice();
    const isPrimary = !!primaryId && primaryId === stepId;
    return rows.filter((w) => w.triggerStepId === stepId || (isPrimary && !w.triggerStepId));
}

/**
 * A complete, runnable signed request. The signature covers
 * `nonce + "\n" + body` — what routes/automation/events.js verifies — and
 * `printf '%s\n%s'` because `echo` would add a newline that is not signed.
 */
export function buildCurlSnippet(url: string, secret: string): string {
    return [
        `BODY='{}'`,
        `NONCE=$(openssl rand -hex 16)`,
        `SIG="sha256=$(printf '%s\\n%s' "$NONCE" "$BODY" | openssl dgst -sha256 -hmac '${secret}' -hex | awk '{print $2}')"`,
        `curl -X POST '${url}' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -H "X-BeeFlow-Signature: $SIG" \\`,
        `  -H "X-BeeFlow-Nonce: $NONCE" \\`,
        `  --data "$BODY"`,
    ].join('\n');
}

/** As wide as the secret, last four visible: enough to check it is the right one. */
export function maskSecret(secret: unknown): string {
    const s = String(secret || '');
    if (s.length <= 8) return '••••••••';
    return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

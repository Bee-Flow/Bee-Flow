/**
 * The per-minute budget of the App Studio `code` step (componentSpecs/steps/code.js): one
 * sandbox run per hit, so it has a bucket of its own, STUDIO_APP_CODE_RPM (default 120,
 * 0 = no limit).
 *
 *   codeStepLimiter        a signed-in click and a background job: per (viewer, app), like the
 *                          other step buckets (studioAppStepBudget.mts charges it)
 *   checkPublicCodeBudget  an anonymous visitor of a public page: per (page, IP), on top of the
 *                          page's ordinary step bucket (studioAppPublic.js)
 *
 * Built on first use, so a test can set the env before it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const CODE_RPM_ENV = 'STUDIO_APP_CODE_RPM';
export const CODE_RPM_DEFAULT = 120;

type Req = { params?: Record<string, string | undefined>; ip?: string; session?: unknown };
export type CodeLimiter = {
    check: (req: unknown, res: unknown) => Promise<boolean>;
    take: (key: string, cost?: number) => Promise<{ ok: true } | { ok: false; retryAfterSecs: number }>;
    limiterName: string;
    max: number;
};

type SpendLimiter = (opts: { env: string; fallback: number; name: string; keyFn: (req: Req) => string; _env?: Record<string, string | undefined> }) => Partial<CodeLimiter> & { max: number; limiterName?: string };

/** A spend limiter for STUDIO_APP_CODE_RPM; at 0 it lets everything through (check and take included). */
export function buildCodeLimiter(name: string, keyFn: (req: Req) => string, env: Record<string, string | undefined> = process.env): CodeLimiter {
    const { spendLimiter } = nodeRequire('../utils/perUserRateLimit.js') as { spendLimiter: SpendLimiter };
    const limiter = spendLimiter({ env: CODE_RPM_ENV, fallback: CODE_RPM_DEFAULT, name, keyFn, _env: env });
    if (limiter.max === 0) {
        return Object.assign(limiter, { check: async () => true, take: async () => ({ ok: true as const }), limiterName: name, max: 0 });
    }
    return limiter as CodeLimiter;
}

let signedIn: CodeLimiter | null = null;
let publicPage: CodeLimiter | null = null;

/** Per (viewer, app): the key the other App Studio step buckets use (studioAppRateLimits.actionRunKey). */
export function codeStepLimiter(): CodeLimiter {
    if (!signedIn) {
        const { actionRunKey } = nodeRequire('./studioAppRateLimits.js') as { actionRunKey: (req: Req) => string };
        signedIn = buildCodeLimiter('studio-code-step', actionRunKey);
    }
    return signedIn;
}

function publicCodeLimiter(): CodeLimiter {
    if (!publicPage) publicPage = buildCodeLimiter('studio-public-code-step', (req) => `pubapp-code:${req.params?.token ?? ''}:${req.ip || 'unknown'}`);
    return publicPage;
}

/** The public step route's extra charge: true when the step may go on (any other kind always may). */
export async function checkPublicCodeBudget(kind: unknown, req: unknown, res: unknown): Promise<boolean> {
    if (kind !== 'code') return true;
    return publicCodeLimiter().check(req, res);
}

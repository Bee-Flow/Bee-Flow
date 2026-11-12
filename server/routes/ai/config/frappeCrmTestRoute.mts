/**
 * POST /ai/frappe-crm/test — can Bee Flow reach the Frappe CRM site with these
 * values? Accepts the unsaved values of the settings form; anything left out
 * falls back to the stored secret. Answers { ok: true, user } (the Frappe user
 * the key logs in as) or { ok: false, error } with a fixed sentence per kind of
 * failure. At most INTEGRATION_TEST_MAX_PER_MINUTE tests per user per minute. The stored secret is only used
 * with the stored site and key: a typed site or key that differs needs its
 * secret typed too. The secret is never echoed.
 *
 * Mounted by routes/ai/config/integrations.js. The collaborators are parameters
 * (a test passes fakes), defaulting to the real ones on first use.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import { frappeCrmFields } from './frappeCrmFields.mts';
import { integrationTestLimiter } from './integrationTestLimit.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { HttpError } = nodeRequire('../../../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { validate } = nodeRequire('../../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { lazyGate } = nodeRequire('../../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>) => unknown };

const FrappeCrmTestBody = bodyOf(Object.fromEntries(Object.entries(frappeCrmFields).map(([k, v]) => [k, v.optional()])));
const TEST_TIMEOUT_MS = 15_000;
export const NOT_CONFIGURED = 'Frappe CRM is not connected. Add the site address, API key and API secret in Settings > Connections.';
export const SECRET_NEEDED = 'Enter the API secret to test a different Frappe CRM site or API key.';
export const CONNECT_FAILED = 'Could not connect to Frappe CRM. Check the site address, the API key and the API secret.';

export interface TestCreds { url: string; apiKey: string; apiSecret: string }
export interface TestOutcome { ok?: boolean; error?: string; user?: string }
export interface FrappeCrmTestDeps {
    getSecret?: (key: string) => Promise<string | null | undefined>;
    testConnection?: (creds: TestCreds) => Promise<TestOutcome>;
    requireAuth?: RequestHandler;
    /** The per-user limit (./integrationTestLimit.mts). */
    rateLimit?: RequestHandler;
}

type TestBody = { frappeCrmUrl?: string | null; frappeCrmApiKey?: string | null; frappeCrmApiSecret?: string | null };

async function credsFor(req: Request, getSecret: (key: string) => Promise<string | null | undefined>): Promise<TestCreds & { secretNeeded?: boolean }> {
    const userId = (req.session as unknown as { user?: { id?: string } } | undefined)?.user?.id;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'Not authenticated');
    const body = (req.body || {}) as TestBody;
    const stored = async (field: string) => String((await getSecret(`frappe_crm_${field}_user_${userId}`)) || '').trim();
    const typedUrl = String(body.frappeCrmUrl || '').trim();
    const typedKey = String(body.frappeCrmApiKey || '').trim();
    const typedSecret = String(body.frappeCrmApiSecret || '').trim();
    const storedUrl = await stored('url');
    const storedKey = await stored('api_key');
    // The stored secret goes only with the stored site and key.
    const otherTarget = (typedUrl && typedUrl.toLowerCase() !== storedUrl.toLowerCase()) || (typedKey && typedKey !== storedKey);
    if (otherTarget && !typedSecret) return { url: typedUrl, apiKey: typedKey, apiSecret: '', secretNeeded: true };
    return {
        url: typedUrl || storedUrl,
        apiKey: typedKey || storedKey,
        apiSecret: typedSecret || await stored('api_secret'),
    };
}

/** The race of the test against its timeout; the timer never outlives the answer. */
async function withTimeout(pending: Promise<TestOutcome>): Promise<TestOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<TestOutcome>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('timed out')), TEST_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export function createFrappeCrmTestRouter(deps: FrappeCrmTestDeps = {}): Router {
    const router = express.Router();
    // lazyGate keeps the deferred require and tags the mount as the session gate it is.
    const auth = deps.requireAuth || lazyGate(() => (nodeRequire('../../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });
    const getSecret = deps.getSecret || ((key: string) => (nodeRequire('../../../stores/configStore.js') as { getSecret: (k: string) => Promise<string | null | undefined> }).getSecret(key));
    const testConnection = deps.testConnection
        || (async (creds: TestCreds) => (await import('../../../integrations/frappeCrmTools.mts')).testFrappeCrmConnection(creds));

    const limit = deps.rateLimit || integrationTestLimiter('frappe-crm-test');

    router.post('/frappe-crm/test', auth, limit, validate({ body: FrappeCrmTestBody }), async (req: Request, res: Response) => {
        const { secretNeeded, ...creds } = await credsFor(req, getSecret);
        if (secretNeeded) return res.json({ ok: false, error: SECRET_NEEDED });
        if (!creds.url || !creds.apiKey || !creds.apiSecret) return res.json({ ok: false, error: NOT_CONFIGURED });
        const scrub = (message: unknown) => String(message || CONNECT_FAILED).split(creds.apiSecret).join('***').slice(0, 300);
        try {
            const outcome = await withTimeout(testConnection(creds));
            if (!outcome || !outcome.ok) return res.json({ ok: false, error: scrub(outcome && outcome.error) });
            return res.json({ ok: true, user: outcome.user });
        } catch {
            return res.json({ ok: false, error: CONNECT_FAILED });
        }
    });
    return router;
}

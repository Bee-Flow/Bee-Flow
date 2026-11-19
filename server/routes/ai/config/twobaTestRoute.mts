/**
 * POST /ai/twoba/test: can Bee Flow reach 2BA with this connection? Answers
 * { ok: true, companyName, databaseName } (GET /CompanyConditions/currentUserStatus:
 * the 2BA company and the Online Condition Server database it prices with) or
 * { ok: false, error }.
 *
 * Password sign-in: the unsaved values of the form are tried; anything left
 * out falls back to the stored value. The stored secret only goes with the
 * stored client id, the stored password only with the stored user name: a
 * typed client id or user name that differs needs its secret or password typed
 * too. "Sign in with 2BA": the stored connection and its sign-in are tried.
 * Nothing secret is echoed. At most INTEGRATION_TEST_MAX_PER_MINUTE tests per
 * user per minute.
 *
 * Mounted by routes/ai/config/integrations.js; the collaborators are
 * parameters, so a test passes fakes.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import { twobaFields } from '../../../usecases/ai/config/twobaFields.mts';
import { integrationTestLimiter, withTestTimeout } from '../../../usecases/ai/config/integrationTestLimit.mts';
import type { TwobaConfig } from '../../../integrations/twobaAuth.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { HttpError } = nodeRequire('../../../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { validate } = nodeRequire('../../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { lazyGate } = nodeRequire('../../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>) => unknown };

const TwobaTestBody = bodyOf(Object.fromEntries(Object.entries(twobaFields).map(([k, v]) => [k, v.optional()])));
const TEST_TIMEOUT_MS = 20_000;
export const SECRET_NEEDED = 'Enter the client secret to test a different 2BA client id.';
export const PASSWORD_NEEDED = 'Enter the password to test a different 2BA user name.';
export const CONNECT_FAILED = 'Could not connect to 2BA. Check the client id, the client secret and the sign-in.';

export interface TestOutcome { ok: boolean; companyName?: string | null; databaseName?: string | null; error?: string }
export interface TwobaTestDeps {
    getSecret?: (key: string) => Promise<string | null | undefined>;
    testConnection?: (userId: string, cfg: TwobaConfig) => Promise<TestOutcome>;
    requireAuth?: RequestHandler;
    rateLimit?: RequestHandler;
}

type TestBody = Partial<Record<keyof typeof twobaFields, string | null>>;

type Pair = { name: string; secret: string } | { refuse: string };

/**
 * A name and its secret (client id + secret, user name + password): typed or
 * stored. The stored secret only goes with the stored name.
 */
async function pairToTry(typedName: string, typedSecret: string, storedName: string, storedSecret: () => Promise<string>, refuse: string): Promise<Pair> {
    if (typedName && typedName !== storedName && !typedSecret) return { refuse };
    return { name: typedName || storedName, secret: typedSecret || await storedSecret() };
}

/** The configuration to try, or the sentence that says what is missing. */
async function configToTry(userId: string, body: TestBody, getSecret: (key: string) => Promise<string | null | undefined>): Promise<TwobaConfig | { refuse: string }> {
    const stored = async (field: string) => String((await getSecret(`twoba_${field}_user_${userId}`)) || '');
    const typed = (key: keyof TestBody) => String(body[key] || '').trim();
    const modeText = typed('twobaAuthMode') || (await stored('auth_mode')).trim();
    const mode = modeText === 'authorization_code' ? 'authorization_code' : 'password';
    const client = await pairToTry(typed('twobaClientId'), typed('twobaClientSecret'), (await stored('client_id')).trim(), async () => (await stored('client_secret')).trim(), SECRET_NEEDED);
    if ('refuse' in client) return client;
    if (mode === 'authorization_code') return { clientId: client.name, clientSecret: client.secret, mode, username: '', password: '' };
    // A password keeps its spaces as typed.
    const account = await pairToTry(typed('twobaUsername'), String(body.twobaPassword || ''), (await stored('username')).trim(), () => stored('password'), PASSWORD_NEEDED);
    if ('refuse' in account) return account;
    return { clientId: client.name, clientSecret: client.secret, mode, username: account.name, password: account.secret };
}

export function createTwobaTestRouter(deps: TwobaTestDeps = {}): Router {
    const router = express.Router();
    // lazyGate keeps the deferred require and tags the mount as the session gate it is.
    const auth = deps.requireAuth || lazyGate(() => (nodeRequire('../../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });
    const getSecret = deps.getSecret || ((key: string) => (nodeRequire('../../../stores/configStore.js') as { getSecret: (k: string) => Promise<string | null | undefined> }).getSecret(key));
    const testConnection = deps.testConnection
        || (async (userId: string, cfg: TwobaConfig) => (await import('../../../integrations/twobaTools.mts')).testTwobaConnection(userId, cfg));
    const limit = deps.rateLimit || integrationTestLimiter('twoba-test');

    router.post('/twoba/test', auth, limit, validate({ body: TwobaTestBody }), async (req: Request, res: Response) => {
        const userId = (req.session as unknown as { user?: { id?: string } } | undefined)?.user?.id;
        if (!userId) throw new HttpError(401, 'unauthenticated', 'Not authenticated');
        const cfg = await configToTry(userId, (req.body || {}) as TestBody, getSecret);
        if ('refuse' in cfg) return res.json({ ok: false, error: cfg.refuse });
        try {
            const outcome = await withTestTimeout(testConnection(userId, cfg), TEST_TIMEOUT_MS);
            if (!outcome || !outcome.ok) return res.json({ ok: false, error: String(outcome?.error || CONNECT_FAILED).slice(0, 300) });
            return res.json({ ok: true, companyName: outcome.companyName ?? null, databaseName: outcome.databaseName ?? null });
        } catch {
            return res.json({ ok: false, error: CONNECT_FAILED });
        }
    });
    return router;
}

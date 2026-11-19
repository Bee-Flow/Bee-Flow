/**
 * The per-user limit on the connection-test routes of the integration settings
 * (POST /ai/frappe-crm/test, POST /ai/firebird/test, POST /ai/twoba/test): each
 * test makes the server open a connection to an address the person typed.
 *
 * INTEGRATION_TEST_MAX_PER_MINUTE (default 20, 0 = unlimited) tests per user
 * per minute, per route. Also the time-out race those tests share.
 */

import { createRequire } from 'node:module';
import type { RequestHandler } from 'express';

const nodeRequire = createRequire(import.meta.url);
const { perUserRateLimit } = nodeRequire('../../../utils/perUserRateLimit.js') as {
    perUserRateLimit: (o: { windowMs: number; max: number; name?: string }) => RequestHandler;
};
const { envByteLimit } = nodeRequire('../../../core/http/httpResponseLimits.js') as { envByteLimit: (name: string, fallback: number) => number };

export const MAX_ENV = 'INTEGRATION_TEST_MAX_PER_MINUTE';
export const DEFAULT_MAX = 20;

/** The limiter for one test route; a pass-through when the limit is 0. */
export function integrationTestLimiter(name: string): RequestHandler {
    const max = envByteLimit(MAX_ENV, DEFAULT_MAX);
    if (!Number.isFinite(max)) return (_req, _res, next) => next();
    return perUserRateLimit({ windowMs: 60_000, max, name });
}

/** `pending`, or a rejection after `ms`; the timer never outlives the answer. */
export async function withTestTimeout<T>(pending: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([pending, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]);
    } finally {
        clearTimeout(timer);
    }
}

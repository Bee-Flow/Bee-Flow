/**
 * App Studio: the address of a webhook trigger, mounted at /api/app-hooks (index.js).
 *
 *   POST /:endpointId   a signed delivery from another system; 202 { accepted, deliveryId }
 *
 * No session: the signature over the bytes that were sent is the credential
 * (appStudio/triggers/webhook/webhookReceive.mts has the recipe, the order of the checks and
 * what is kept). The id in the address is an address, not a secret, and nothing in the request
 * selects the app or the trigger: the endpoint row does.
 *
 * What a caller without the secret can learn is nothing: an unknown address, a missing or wrong
 * signature, a timestamp outside the window, a paused trigger and an unpublished app are the
 * same 404. Before the address is looked at, and the same for every address: the per-address
 * rate limit (429), the content type (415) and the size of the body (413).
 *
 * This router reads its own body (boot/httpMiddleware.js parsesOwnBody): the bytes as sent, up to
 * STUDIO_APP_WEBHOOK_BODY_MAX_BYTES, for the signature.
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';
import { defaultReceiveDeps, receiveWebhook } from '../appStudio/triggers/webhook/webhookReceive.mts';
import type { ReceiveDeps } from '../appStudio/triggers/webhook/webhookReceive.mts';
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../appStudio/triggers/webhook/webhookEndpoints.mts';
import { webhookLimits } from '../stores/studioAppData/webhookPolicy.mts';

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

const express = nodeRequire('express') as typeof import('express');
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { perUserRateLimit } = nodeRequire('../utils/perUserRateLimit.js') as { perUserRateLimit: (o: Record<string, unknown>) => Handler };
// The primitives of the automation webhook: the `sha256=<hex>` header and its constant-time compare.
const { hmacHeader, sameSignature } = nodeRequire('../usecases/automation/webhookSignature.js') as {
    hmacHeader: (secret: string, message: string) => string;
    sameSignature: (given: string, expected: string) => boolean;
};

const notFound = (): Error => new HttpError(404, 'not_found', 'Not found');

/** The router, with the receive's dependencies (a test hands its own in). */
export function makeStudioAppWebhookRouter(given: Partial<ReceiveDeps> = {}, env: Record<string, string | undefined> = process.env) {
    const limits = webhookLimits(env);
    const deps: ReceiveDeps = { ...defaultReceiveDeps({ sign: hmacHeader, same: sameSignature }), ...given };

    const ipLimiter: Handler = limits.rpmPerIp === 0
        ? (_req, _res, next) => next()
        : perUserRateLimit({ windowMs: 60_000, max: limits.rpmPerIp, name: 'studio-app-webhook-ip', keyFn: (req: Request) => `apphook:${req.ip || 'unknown'}` });

    const jsonOnly: Handler = (req, _res, next) => {
        if (!req.is('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send the delivery as application/json.');
        next();
    };

    // The bytes as sent: the signature covers them, so nothing parses or rebuilds the body first.
    const rawBody = express.raw({ type: 'application/json', limit: limits.bodyMaxBytes || Infinity });

    async function receive(req: Request, res: Response): Promise<void> {
        res.set('Cache-Control', 'no-store');
        const out = await receiveWebhook({
            endpointId: String(req.params.endpointId || ''),
            signature: req.get(SIGNATURE_HEADER) || '',
            timestamp: req.get(TIMESTAMP_HEADER) || '',
            nonce: req.get(NONCE_HEADER) || '',
            rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            headers: req.headers,
        }, deps);
        if (out.status === 404) throw notFound();
        if (out.status === 202) {
            res.status(202).json(out.body);
            return;
        }
        if (out.status === 429) res.set('Retry-After', String(out.retryAfterSecs));
        throw new HttpError(out.status, out.code, out.error);
    }

    const router = express.Router();
    router.post('/:endpointId', ipLimiter, jsonOnly, rawBody, receive);
    return router;
}

export const studioAppWebhookRouter = makeStudioAppWebhookRouter();

/**
 * App Studio: the assets of a PUBLIC page, mounted at /api/public-app next to
 * studioAppPublic.js (index.js).
 *
 *   GET /:token/assets/:assetId   the bytes of an asset the public definition refers to
 *
 * The page token is the credential, as for GET /:token: no visitor bearer, because an <img>
 * and an @font-face cannot send one. What it opens is narrower than the app's asset store:
 * only an asset named somewhere in the definition the anonymous visitor is served
 * (publicAccess.buildPublicDefinition of the published bytes), so an asset used only on a
 * back-office screen, or not used at all, answers the same 404 as an unknown token.
 * An unknown token, a revoked page, an unpublished app and an app without publicAccess are
 * one 404, as on the rest of the public router.
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';
import { assetResponseHeaders, collectAssetRefs, isAssetId } from '../appStudio/appAssets.mts';
import { getAssetRow, openAsset } from '../appStudio/appAssetStore.mts';
import type { AssetApp } from '../appStudio/appAssetStore.mts';
import { rpmFromEnv } from './studioAppAssets.mts';

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type StudioApp = AssetApp & { isPublished?: boolean };
type Surface = { ok: boolean };

const express = nodeRequire('express') as typeof import('express');
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { perUserRateLimit } = nodeRequire('../utils/perUserRateLimit.js') as { perUserRateLimit: (o: Record<string, unknown>) => Handler };
const { sendStream } = nodeRequire('../core/http/sendStream.js') as { sendStream: (s: unknown, res: Response, onError: (e: Error) => void) => void };
const studioAppStore = nodeRequire('../stores/studioAppStore.js') as {
    getPublicPage: (token: string) => Promise<{ appId: string } | null>;
    getStudioApp: (id: string) => Promise<StudioApp | null>;
};
const publicAccess = nodeRequire('../appStudio/publicAccess.js') as {
    resolvePublicSurface: (def: unknown) => Surface;
    buildPublicDefinition: (def: unknown, surface: Surface) => unknown;
};

const HEX = '0123456789abcdef';

/** A page token: 24..64 lower-case hex characters (studio_app_public_pages.id). */
export function isPageToken(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 24 || value.length > 64) return false;
    for (const ch of value) if (!HEX.includes(ch)) return false;
    return true;
}

const max = rpmFromEnv('STUDIO_APP_PUBLIC_ASSET_RPM_PER_IP', 300);
const ipLimiter: Handler = max === 0
    ? (_req, _res, next) => next()
    : perUserRateLimit({ windowMs: 60_000, max, name: 'studio-public-assets', keyFn: (req: Request) => `pubapp-asset:${req.ip || 'unknown'}` });

function notFound(): Error {
    return new HttpError(404, 'not_found', 'Not found');
}

/** The published app behind a page token, and the definition its visitors get; null for every kind of "no". */
async function publicDefinitionOf(token: string): Promise<{ app: StudioApp; definition: unknown } | null> {
    const page = await studioAppStore.getPublicPage(token);
    const app = page ? await studioAppStore.getStudioApp(page.appId) : null;
    const published = app && app.isPublished ? app.publishedDefinition : null;
    if (!app || !published) return null;
    const surface = publicAccess.resolvePublicSurface(published);
    if (!surface.ok) return null;
    return { app, definition: publicAccess.buildPublicDefinition(published, surface) };
}

async function read(req: Request, res: Response, next: NextFunction): Promise<void> {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const { token, assetId } = req.params;
    if (!isPageToken(token) || !isAssetId(assetId)) throw notFound();
    const found = await publicDefinitionOf(token);
    if (!found || !collectAssetRefs(found.definition).has(assetId)) throw notFound();
    const row = await getAssetRow(found.app, assetId);
    const obj = row ? await openAsset(found.app, row) : null;
    if (!row || !obj) throw notFound();
    for (const [name, value] of Object.entries(assetResponseHeaders(row.mimeType))) res.setHeader(name, value);
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    sendStream(obj.stream, res, next);
}

export const publicAppAssetsRouter = express.Router();
publicAppAssetsRouter.get('/:token/assets/:assetId', ipLimiter, read);

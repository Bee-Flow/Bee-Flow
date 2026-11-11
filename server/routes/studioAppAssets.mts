/**
 * App Studio: the asset store of an app (a logo, a picture, a font), mounted at
 * /api/studio-apps next to the attachment router (index.js).
 *
 *   GET    /:id/assets            the app's assets, each with where the draft and the published app use it
 *   POST   /:id/assets            upload one PNG, JPEG, WebP, GIF or WOFF2 (multipart field `file`)
 *   GET    /:id/assets/:assetId   the bytes, for <img> and @font-face
 *   DELETE /:id/assets/:assetId   delete one
 *
 * Who may do what:
 *   - Listing, uploading and deleting are editing the app: the owner, with manage_apps for the
 *     two writes, as saving the definition requires (routes/studioApps/crud.js). Anyone else
 *     gets the uniform 404, before a byte of an upload is read.
 *   - Reading the bytes is opening the app: the owner, or a viewer of the published app in its
 *     audience (studioAppStore.canReadStudioAppAsync), as the attachment router answers.
 *   - An asset id of another app, a record attachment's id and an unknown id are all a 404.
 *
 * The upload goes through middleware/uploadGuard with the asset type list and size cap; the
 * route then trusts only the sniffed type (appAssets.mts), and the store does quota, put, scan
 * and ledger row in that order (appAssetStore.mts). SVG is not accepted.
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';
import { ASSET_LIMITS, ASSET_MIMES, assetResponseHeaders, isAssetId, sniffAssetMime } from '../appStudio/appAssets.mts';
import { deleteAsset, getAssetRow, listAssets, openAsset, storeAsset } from '../appStudio/appAssetStore.mts';
import type { AssetApp } from '../appStudio/appAssetStore.mts';

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type StudioApp = AssetApp & { isPublished?: boolean; organizationId?: string | null };
type Locals = { asset_app?: StudioApp };

const express = nodeRequire('express') as typeof import('express');
const { requireAuth } = nodeRequire('../auth/permissions.js') as { requireAuth: Handler };
const { requireManageApps, audienceFor } = nodeRequire('./studioApps/access.js') as {
    requireManageApps: Handler;
    audienceFor: (req: Request) => Promise<{ orgIdArr: string[]; userGroups: string[] }>;
};
const { validate } = nodeRequire('../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => Handler };
const { z, worded } = nodeRequire('../core/http/schemaParts.js') as { z: typeof import('zod').z; worded: (text: string) => import('zod').ZodString };
const { uploadGuard } = nodeRequire('../middleware/uploadGuard.js') as { uploadGuard: (o: { maxBytes: number; allow: readonly string[] }) => Handler };
const { perUserRateLimit } = nodeRequire('../utils/perUserRateLimit.js') as { perUserRateLimit: (o: Record<string, unknown>) => Handler };
const { sendStream } = nodeRequire('../core/http/sendStream.js') as { sendStream: (s: unknown, res: Response, onError: (e: Error) => void) => void };
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { fontMaxBytes } = nodeRequire('../appStudio/appFontRoles.js') as { fontMaxBytes: () => number };
const studioAppStore = nodeRequire('../stores/studioAppStore.js') as {
    getStudioApp: (id: string) => Promise<StudioApp | null>;
    canReadStudioAppAsync: (app: StudioApp, userId: string, groups: string[], orgIds: string[]) => Promise<boolean>;
};

/** A per-minute budget from the environment: the default when unset or not a whole number, none at all for 0. */
export function rpmFromEnv(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
    const raw = String(env[name] ?? '').trim();
    const n = Number(raw);
    return raw && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** A per-viewer, per-app limiter; 0 switches it off. */
function limiter(name: string, envName: string, fallback: number): Handler {
    const max = rpmFromEnv(envName, fallback);
    if (max === 0) return (_req, _res, next) => next();
    return perUserRateLimit({ windowMs: 60_000, max, name, keyFn: (req: Request) => `${userIdOf(req) || 'anon'}:${req.params?.id || 'unknown'}` });
}

const writeLimiter = limiter('studio-app-assets-write', 'STUDIO_APP_ASSET_UPLOAD_RPM', 30);
const readLimiter = limiter('studio-app-assets-read', 'STUDIO_APP_ASSET_READ_RPM', 600);
const guard = uploadGuard({ maxBytes: ASSET_LIMITS.MAX_ASSET_BYTES, allow: ASSET_MIMES });

const APP_ID_TEXT = "The app id is the id in the app's address.";
const ASSET_ID_TEXT = 'The asset id is the id after "asset:" (letters, digits, - and _).';
const appId = worded(APP_ID_TEXT).min(1, APP_ID_TEXT).max(200, APP_ID_TEXT);
const assetId = worded(ASSET_ID_TEXT).refine(isAssetId, ASSET_ID_TEXT);
const AppParams = z.object({ id: appId }).strict();
const AssetParams = z.object({ id: appId, assetId }).strict();
const NoQuery = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
// The file is the guard's; no text field travels beside it.
const NoFields = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

function userIdOf(req: Request): string | null {
    const session = (req as Request & { session?: { user?: { id?: string } } }).session;
    return session?.user?.id || null;
}

function notFound(): Error {
    return new HttpError(404, 'not_found', 'App not found');
}

/** The app, when the caller owns it; the uniform 404 otherwise. */
async function ownedApp(req: Request): Promise<StudioApp> {
    const app = await studioAppStore.getStudioApp(String(req.params.id));
    if (!app || app.userId !== userIdOf(req)) throw notFound();
    return app;
}

/** The app, when the caller may open it: the owner, or the published app's audience. */
async function visibleApp(req: Request): Promise<StudioApp> {
    const app = await studioAppStore.getStudioApp(String(req.params.id));
    const userId = userIdOf(req);
    if (!app || !userId) throw notFound();
    if (app.userId === userId) return app;
    const { orgIdArr, userGroups } = await audienceFor(req);
    if (!app.isPublished || !(await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr))) throw notFound();
    return app;
}

/** Before the upload guard: a stranger is refused without a file being read into memory. */
const requireOwnedApp: Handler = async (req, res, next) => {
    try {
        (res.locals as Locals).asset_app = await ownedApp(req);
        next();
    } catch (err) { next(err); }
};

async function list(req: Request, res: Response): Promise<void> {
    const app = await ownedApp(req);
    res.set('Cache-Control', 'no-store');
    res.json({ assets: await listAssets(app), limits: { maxBytes: ASSET_LIMITS.MAX_ASSET_BYTES, maxAssets: ASSET_LIMITS.MAX_ASSETS_PER_APP, types: ASSET_MIMES } });
}

async function upload(req: Request, res: Response): Promise<void> {
    const app = (res.locals as Locals).asset_app as StudioApp;
    const file = (req as Request & { file?: { buffer: Buffer } }).file;
    if (!file) throw new HttpError(400, 'no_file', 'No file uploaded');
    const mime = sniffAssetMime(file.buffer);
    if (!mime) throw new HttpError(415, 'type_not_allowed', 'An asset is a PNG, JPEG, WebP or GIF image or a WOFF2 font.');
    // A font has an operator limit of its own (STUDIO_APP_FONT_MAX_BYTES, appFontRoles.js).
    const fontMax = fontMaxBytes();
    if (mime === 'font/woff2' && file.buffer.length > fontMax) throw new HttpError(413, 'font_too_large', `A font may be at most ${fontMax} bytes.`);
    res.status(201).json({ asset: await storeAsset(app, file.buffer, mime) });
}

async function read(req: Request, res: Response, next: NextFunction): Promise<void> {
    const app = await visibleApp(req);
    const row = await getAssetRow(app, String(req.params.assetId));
    const obj = row ? await openAsset(app, row) : null;
    if (!row || !obj) throw new HttpError(404, 'not_found', 'Asset not found');
    for (const [name, value] of Object.entries(assetResponseHeaders(row.mimeType))) res.setHeader(name, value);
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    sendStream(obj.stream, res, next);
}

async function remove(req: Request, res: Response): Promise<void> {
    const app = await ownedApp(req);
    if (!(await deleteAsset(app, String(req.params.assetId)))) throw new HttpError(404, 'not_found', 'Asset not found');
    res.json({ success: true });
}

export const studioAppAssetsRouter = express.Router();
studioAppAssetsRouter.get('/:id/assets', requireAuth, readLimiter, validate({ params: AppParams, query: NoQuery }), list);
studioAppAssetsRouter.post('/:id/assets', requireAuth, requireManageApps, writeLimiter, validate({ params: AppParams, query: NoQuery }), requireOwnedApp, guard, validate({ body: NoFields }), upload);
studioAppAssetsRouter.get('/:id/assets/:assetId', requireAuth, readLimiter, validate({ params: AssetParams, query: NoQuery }), read);
studioAppAssetsRouter.delete('/:id/assets/:assetId', requireAuth, requireManageApps, writeLimiter, validate({ params: AssetParams, query: NoQuery }), remove);

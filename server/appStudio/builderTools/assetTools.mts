/**
 * App Studio builder tool app_list_assets: the files uploaded to this app (logo, pictures,
 * fonts), so the builder can name one as `asset:<id>`.
 *
 * Read-only and owner-scoped: the app the turn edits, when the turn's user owns it. The model
 * cannot upload; a person does that in the editor (image, theme logo). Each entry says where
 * the draft and the published app already use it. Built from an explicit list of fields.
 */

import { createRequire } from 'node:module';
import { listAssets } from '../appAssetStore.mts';
import type { AssetApp } from '../appAssetStore.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { warn: (msg: string, meta?: unknown) => void };

const MAX_LISTED = 50;

export const ASSET_TOOL_SCHEMAS = Object.freeze([
    Object.freeze({
        type: 'function',
        function: Object.freeze({
            name: 'app_list_assets',
            description: 'List the files a person uploaded to THIS app (PNG, JPEG, WebP, GIF images and WOFF2 fonts, at most 50, newest first). Read-only, NO arguments. Returns [{ ref, kind, mime, size, usedBy:{draft,published} }]. Use `ref` (asset:<id>) as image.src, image.srcFrom (static) or design.logoUrl / publicAccess.design.logoUrl; any other image still takes an https URL. You cannot upload: when the list is empty or has no fitting file, ask the person to upload one in the editor (image settings or the theme\'s logo field), never invent an asset id.',
            parameters: Object.freeze({ type: 'object', properties: Object.freeze({}) }),
        }),
    }),
]);

type Draft = { appId?: string | null; userId?: string | null };
type ToolResult = Record<string, unknown>;

const studioApps = (): { getStudioApp: (id: string) => Promise<AssetApp | null> } => nodeRequire('../../stores/studioAppStore.js');

export async function applyListAssets(draftWrap: Draft): Promise<ToolResult> {
    if (!draftWrap?.appId) return { assets: [], _hints: ['This app is not saved yet, so it has no uploaded files. Use an https URL, or ask the person to upload a file once the app exists.'] };
    try {
        const app = await studioApps().getStudioApp(draftWrap.appId);
        if (!app || app.userId !== draftWrap.userId) return { error: 'Only the owner of this app can list its uploaded files.' };
        const assets = (await listAssets(app)).slice(0, MAX_LISTED).map((a) => ({
            ref: a.ref,
            kind: a.mime.startsWith('font/') ? 'font' : 'image',
            mime: a.mime,
            size: a.size,
            usedBy: { draft: a.usedBy.draft.slice(0, 5), published: a.usedBy.published.slice(0, 5) },
        }));
        return assets.length
            ? { assets }
            : { assets, _hints: ['No uploaded files yet. Ask the person to upload one in the editor, or use an https URL.'] };
    } catch (e) {
        log.warn('app_list_assets failed', { error: (e as Error).message });
        return { error: 'The uploaded files could not be read just now.' };
    }
}

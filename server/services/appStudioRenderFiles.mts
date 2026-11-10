/**
 * App Studio screenshot: the files the render page asks for besides its document and bundle,
 * answered in-process (the page has no network, appStudioRender.js routes every URL of its
 * fake origin).
 *
 *   fonts/<family>/<file>.woff2              the self-hosted font files the bundle's
 *                                            @font-face rules name (agent-hub
 *                                            marketing/self-hosted-fonts.css), so a screenshot
 *                                            shows the app's chosen font
 *   api/public-app/screenshot/assets/<id>    an `asset:<id>` of the RENDERED app (the headless
 *                                            entry resolves asset refs to this URL, agent-hub
 *                                            appRuntimeScreenshot.tsx SCREENSHOT_ASSET_TOKEN),
 *                                            read through the app's asset store
 *
 * Font files come from the runtime bundle's folder (server/vendor/app-runtime/fonts, staged
 * next to the bundle by scripts/stage-server-context.sh) or, in a dev checkout, straight from
 * agent-hub/public/fonts. Only files found by listing those folders are served: a requested
 * path is looked up, never joined onto a directory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { ASSET_LIMITS, isAssetId } from '../appStudio/appAssets.mts';

const { fallback } = createRequire(import.meta.url)('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value?: T) => T };

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FONT_DIRS = Object.freeze([
    path.join(HERE, '..', 'vendor', 'app-runtime', 'fonts'),
    path.join(HERE, '..', '..', 'agent-hub', 'public', 'fonts'),
]);
export const SCREENSHOT_ASSET_PREFIX = 'api/public-app/screenshot/assets/';
const FONT_PREFIX = 'fonts/';

export interface RouteFile { contentType: string; body: Buffer }
export interface FileApp { id: string; userId: string }
type AssetRow = { id: string; mimeType: string; scanned: boolean; quarantined: boolean };
export interface FileDeps {
    fontDirs?: readonly string[];
    getAssetRow?: (app: FileApp, id: string) => Promise<AssetRow | null>;
    openAsset?: (app: FileApp, row: AssetRow) => Promise<{ stream: Readable } | null>;
}

let fontIndex: Promise<Map<string, string>> | null = null;
let fontIndexDirs: readonly string[] | null = null;

/** `fonts/<family>/<file>.woff2` → absolute path, for the first folder that exists. */
async function listFonts(dirs: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const dir of dirs) {
        let families: string[];
        try { families = await fs.readdir(dir); } catch { continue; }
        for (const family of families) {
            let files: string[];
            try { files = await fs.readdir(path.join(dir, family)); } catch { continue; }
            for (const file of files) if (file.endsWith('.woff2')) out.set(`${FONT_PREFIX}${family}/${file}`, path.join(dir, family, file));
        }
        return out;
    }
    return out;
}

function fontsOf(dirs: readonly string[]): Promise<Map<string, string>> {
    if (!fontIndex || fontIndexDirs !== dirs) {
        fontIndexDirs = dirs;
        fontIndex = listFonts(dirs);
    }
    return fontIndex;
}

async function readCapped(stream: Readable, max: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > max) { stream.destroy(); return null; }
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

async function readAsset(app: FileApp, id: string, deps: FileDeps): Promise<RouteFile | null> {
    if (!isAssetId(id)) return null;
    const store = (deps.getAssetRow && deps.openAsset) ? null : await import('../appStudio/appAssetStore.mts');
    const getRow = deps.getAssetRow || store!.getAssetRow;
    const open = deps.openAsset || store!.openAsset;
    const row = await getRow(app, id);
    // Only a file that passed the scan, as on the app's own pages.
    if (!row || !row.scanned || row.quarantined) return null;
    const obj = await open(app, row as never);
    const body = obj ? await readCapped(obj.stream, ASSET_LIMITS.MAX_ASSET_BYTES) : null;
    return body ? { contentType: row.mimeType, body } : null;
}

/**
 * The answer for one path under the page origin (no leading slash, no query), or null for
 * "nothing here" (the page then gets an empty 204). `app` null: no assets (nothing to read
 * them from), fonts still served.
 */
export function makeFileFulfil(app: FileApp | null, deps: FileDeps = {}): (rel: string) => Promise<RouteFile | null> {
    const dirs = deps.fontDirs || FONT_DIRS;
    return async (rel: string) => {
        if (rel.startsWith(FONT_PREFIX)) {
            const file = (await fontsOf(dirs)).get(rel);
            return file ? { contentType: 'font/woff2', body: await fs.readFile(file) } : null;
        }
        if (app && rel.startsWith(SCREENSHOT_ASSET_PREFIX)) {
            // An asset id is plain characters (isAssetId), so the path segment is taken as is.
            return readAsset(app, rel.slice(SCREENSHOT_ASSET_PREFIX.length), deps).catch((e) => fallback('services/appStudioRenderFiles:asset', e, null));
        }
        return null;
    };
}

/** For tests: forget the font listing. */
export function _resetFontIndex(): void {
    fontIndex = null;
    fontIndexDirs = null;
}

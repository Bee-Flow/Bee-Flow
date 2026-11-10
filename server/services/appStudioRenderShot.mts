/**
 * App Studio screenshot: taking the picture once the page has mounted (appStudioRender.js
 * captureDocument). A screenshot is a STILL, and a deterministic one:
 *
 *   - STILL_CSS in the document and Playwright's `animations: 'disabled'` take every CSS
 *     animation and transition out (a loading skeleton's shimmer was caught at a different
 *     phase on every run), and the caret is hidden;
 *   - the picture waits for the page's fonts, so a self-hosted family is drawn in its own
 *     face instead of the fallback it showed while the file was still loading.
 *
 * What is photographed: the mounted #root (as always), the whole page when a modal is open
 * (the dialog is a portal on <body>, outside #root), or one component (`nodeId`).
 */

import { createRequire } from 'node:module';

const { fallback } = createRequire(import.meta.url)('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value?: T) => T };

export const STILL_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
const FONT_WAIT_MS = 3000;
/** A crop target is on the mounted page or not at all: never sit out the page's default timeout. */
const NODE_WAIT_MS = 1000;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

export interface ShotTarget { nodeId?: string | null; fullPage?: boolean }
interface Box { width: number; height: number }
interface Shootable { screenshot(opts: Record<string, unknown>): Promise<Buffer> }
interface ShotLocator extends Shootable { boundingBox(opts?: { timeout?: number }): Promise<Box | null> }
interface ShotPage extends Shootable {
    $(selector: string): Promise<Shootable | null>;
    locator(selector: string): { first(): ShotLocator };
    evaluate<T>(fn: (ms: number) => Promise<T> | T, arg: number): Promise<T>;
}

const SHOT_OPTS = Object.freeze({ type: 'png', animations: 'disabled', caret: 'hide' });

function plainId(id: unknown): id is string {
    if (typeof id !== 'string' || !id || id.length > 64) return false;
    for (const ch of id) if (!ID_CHARS.includes(ch)) return false;
    return true;
}

/** Wait (bounded) until the fonts the page uses have loaded. */
export async function waitForFonts(page: ShotPage): Promise<void> {
    await page.evaluate((ms) => Promise.race([
        document.fonts.ready.then(() => true),
        new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), ms); }),
    ]), FONT_WAIT_MS).catch((e) => fallback('services/appStudioRenderShot:fonts', e, false));
}

/** The PNG for `target`, plus a note when the asked-for crop could not be made. */
export async function shoot(page: ShotPage, target: ShotTarget | null): Promise<{ png: Buffer; note: string | null }> {
    let note: string | null = null;
    if (target?.nodeId && plainId(target.nodeId)) {
        const node = page.locator(`[data-node-id="${target.nodeId}"]`).first();
        const box = await node.boundingBox({ timeout: NODE_WAIT_MS }).catch((e) => fallback('services/appStudioRenderShot:box', e, null));
        if (box && box.width > 0 && box.height > 0) {
            const png = await node.screenshot({ ...SHOT_OPTS, timeout: NODE_WAIT_MS * 5 }).catch((e) => fallback('services/appStudioRenderShot:node', e, null));
            if (png) return { png, note: null };
        }
        note = `component ${target.nodeId} is not visible on the rendered screen (hidden, on another tab or in a closed dialog), so the whole screen was captured`;
    }
    if (target?.fullPage) return { png: await page.screenshot({ ...SHOT_OPTS, fullPage: true }), note };
    const root = await page.$('#root').catch((e) => fallback('services/appStudioRenderShot:root', e, null));
    const png = root ? await root.screenshot(SHOT_OPTS).catch((e) => fallback('services/appStudioRenderShot:rootShot', e, null)) : null;
    return { png: png || await page.screenshot(SHOT_OPTS), note };
}

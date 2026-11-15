/**
 * The bytes of one image in the caller's Nextcloud, for an automation step
 * that shows the picture to a model (core/automationRunner/aiStepImages.mts).
 *
 * Not a tool: nothing here is offered to a model or written to a run. The
 * step names the image by the `sourceHandle` an earlier `nextcloud_read_file`
 * answered (readFile.js), and this module fetches it again as the same user,
 * bounded by `maxBytes`. The type is decided by the BYTES (a declared
 * `image/jpeg` that is not one is refused), and only the four formats every
 * model that sees accepts are passed on: PNG, JPEG, GIF and WebP. Anything
 * else (TIFF, HEIC, BMP, SVG) is answered with a reason, and the step uses
 * the text read from the image instead.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type NcFetch = (url: string, init: Record<string, unknown>) => Promise<Response>;

export interface ImageReadCtx {
    ncFetch: NcFetch;
    root: string;
    authError: string;
}

export type ImageRead =
    | { ok: true; buffer: Buffer; mimeType: ImageMime }
    | { ok: false; reason: string };

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** The image type of these bytes, by their signature; null for anything else. */
export function sniffImageMime(buf: Buffer): ImageMime | null {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

/** One image, read as the caller, at most `maxBytes` (0 = no cap). */
export async function readNextcloudImage(path: string, ctx: ImageReadCtx, { maxBytes = 0 }: { maxBytes?: number } = {}): Promise<ImageRead> {
    const { joinDavPath } = nodeRequire('./webdav') as { joinDavPath: (root: string, p: string) => string };
    const { readBytesBounded } = nodeRequire('../../core/http/httpResponseLimits') as {
        readBytesBounded: (res: Response, o: { byteCap: number }) => Promise<{ buffer: Buffer | null; truncated: boolean }>;
    };
    let res: Response;
    try {
        res = await ctx.ncFetch(joinDavPath(ctx.root, path), {});
    } catch (e) {
        if ((e as { code?: string }).code === 'NC_BAD_PATH') return { ok: false, reason: 'the image path is not valid' };
        return { ok: false, reason: 'Nextcloud could not be reached' };
    }
    if (res.status === 404) return { ok: false, reason: 'the image is no longer in Nextcloud' };
    if (res.status === 401) return { ok: false, reason: ctx.authError };
    if (!res.ok) return { ok: false, reason: `Nextcloud answered ${res.status}` };
    const { buffer, truncated } = await readBytesBounded(res, { byteCap: maxBytes > 0 ? maxBytes : Infinity });
    if (truncated || !buffer) return { ok: false, reason: 'the image is larger than the size limit for images sent to AI' };
    const mimeType = sniffImageMime(buffer);
    if (!mimeType) return { ok: false, reason: 'the file is not a PNG, JPEG, GIF or WebP image' };
    return { ok: true, buffer, mimeType };
}

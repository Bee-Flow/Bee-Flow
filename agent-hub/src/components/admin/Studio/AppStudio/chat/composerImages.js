import { readAsDataUrl, resizeImageForUpload } from '../../../../../utils/imageResize';

/**
 * Staging images for the AI builder composer — paste (Ctrl+V of a screenshot,
 * the primary path) and the attach button share this one code path.
 *
 * These limits MIRROR the server's (routes/ai/appStudioBuilder.js). They exist
 * so the user finds out in the composer instead of after a 5MB upload — the
 * server is the control, this is the courtesy.
 */
export const IMAGE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const IMAGE_ACCEPT_ATTR = IMAGE_MIME_ALLOWLIST.join(',');
export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Decoded byte length of a base64 data URL's payload (no buffer allocated). */
export function dataUrlBytes(dataUrl) {
    const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
    if (comma < 0) return 0;
    const b64 = dataUrl.slice(comma + 1);
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
}

const isImageFile = (f) => !!f && typeof f.type === 'string' && f.type.startsWith('image/');

/** DataTransferItemList / FileList are array-LIKE — index them, never for..of. */
function indexed(arrayLike) {
    const out = [];
    for (let i = 0; i < (arrayLike?.length || 0); i++) out.push(arrayLike[i]);
    return out;
}

/**
 * The image files on a paste/drop DataTransfer, in order. Reads `.items`
 * first (a pasted screenshot only ever shows up there) and falls back to
 * `.files` for browsers/tests that only populate that.
 */
export function imageFilesFrom(dataTransfer) {
    if (!dataTransfer) return [];
    const fromItems = indexed(dataTransfer.items)
        .filter((item) => item && item.kind === 'file' && isImageFile(item))
        .map((item) => item.getAsFile?.())
        .filter(Boolean);
    if (fromItems.length) return fromItems;
    return indexed(dataTransfer.files).filter(isImageFile);
}

let seq = 0;

const BAD_TYPE = (name) => `${name} isn't a supported image — use PNG, JPEG, WebP or GIF.`;

// The downscale path decodes the image through the browser. A decode that
// neither loads nor errors (a corrupt paste, a headless/odd environment) would
// otherwise leave the composer waiting forever with no thumbnail and no error,
// so it gets a hard budget and we fall back to the raw bytes.
const RESIZE_BUDGET_MS = 6000;

function withBudget(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => { setTimeout(() => resolve(null), ms); }),
    ]);
}

/**
 * One file → a data URL, downscaled when that helps. Shared utils/imageResize
 * does the work (1568px longest edge, JPEG q=0.92, PNG kept when the source
 * has transparency) — a 4K screenshot is otherwise thousands of wasted vision
 * tokens. GIFs pass through untouched (resizing drops the animation), so an
 * oversized GIF is the one case that can still trip the size cap.
 *
 * → { dataUrl, mimeType } or null when the file cannot be read at all.
 */
async function toDataUrl(file, fallbackType) {
    try {
        const resized = await withBudget(resizeImageForUpload(file), RESIZE_BUDGET_MS);
        if (resized?.dataUrl) {
            return {
                dataUrl: resized.dataUrl,
                mimeType: String(resized.mimeType || fallbackType).toLowerCase(),
            };
        }
    } catch {
        // Downscaling is best-effort (no canvas / decode failure) — the raw
        // file still beats losing the user's screenshot.
    }
    try {
        return { dataUrl: await readAsDataUrl(file), mimeType: fallbackType };
    } catch {
        return null;
    }
}

/** One file → a staged image, or an error line. */
async function stageOne(file) {
    const name = file?.name || 'That image';
    const type = String(file?.type || '').toLowerCase();
    if (!IMAGE_MIME_ALLOWLIST.includes(type)) return { error: BAD_TYPE(file?.name || 'That file') };

    const read = await toDataUrl(file, type);
    if (!read) return { error: `${name} could not be read.` };
    // The resize step can transcode (PNG → JPEG); re-check the RESULT's type so
    // we never stage something the server would then reject.
    if (!IMAGE_MIME_ALLOWLIST.includes(read.mimeType)) return { error: BAD_TYPE(file?.name || 'That file') };

    const bytes = dataUrlBytes(read.dataUrl);
    if (bytes > MAX_IMAGE_BYTES) {
        return { error: `${name} is too large (${(bytes / (1024 * 1024)).toFixed(1)} MB) — the limit is ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.` };
    }
    seq += 1;
    return { image: { id: `img_${seq}`, dataUrl: read.dataUrl, name: file?.name || 'Pasted image', mimeType: read.mimeType, bytes } };
}

/**
 * Turn pasted/dropped/picked files into staged composer images.
 *
 * → { images: [{ id, dataUrl, name, mimeType, bytes }], errors: [string] }
 * Never throws: a file that cannot be read becomes an error line, and the rest
 * still stage.
 */
export async function prepareComposerImages(files, alreadyStaged = 0) {
    const list = Array.from(files || []);
    const images = [];
    const errors = [];
    const room = Math.max(0, MAX_IMAGES_PER_TURN - alreadyStaged);
    if (!list.length) return { images, errors };
    if (room === 0) {
        return { images, errors: [`You can attach at most ${MAX_IMAGES_PER_TURN} images per message.`] };
    }
    if (list.length > room) {
        errors.push(`Only the first ${room} image${room === 1 ? '' : 's'} were attached — the limit is ${MAX_IMAGES_PER_TURN} per message.`);
    }

    for (const file of list.slice(0, room)) {
        const result = await stageOne(file);
        if (result.error) errors.push(result.error);
        else images.push(result.image);
    }
    return { images, errors };
}

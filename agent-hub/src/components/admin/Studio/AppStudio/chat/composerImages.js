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

/** English fallback when no translator is passed (tests, non-React callers). */
const tr = (t, key, en, params) => (t
    ? t(key, en, params)
    : en.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)));

const BAD_TYPE = (t, name) => tr(t, 'studio_apps_edit.composer_images.bad_type', '{name} isn\'t a supported image — use PNG, JPEG, WebP or GIF.', { name });

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
async function stageOne(file, t) {
    const name = file?.name || tr(t, 'studio_apps_edit.composer_images.that_image', 'That image');
    const type = String(file?.type || '').toLowerCase();
    if (!IMAGE_MIME_ALLOWLIST.includes(type)) return { error: BAD_TYPE(t, file?.name || tr(t, 'studio_apps_edit.composer_images.that_file', 'That file')) };

    const read = await toDataUrl(file, type);
    if (!read) return { error: tr(t, 'studio_apps_edit.composer_images.unreadable', '{name} could not be read.', { name }) };
    // The resize step can transcode (PNG → JPEG); re-check the RESULT's type so
    // we never stage something the server would then reject.
    if (!IMAGE_MIME_ALLOWLIST.includes(read.mimeType)) return { error: BAD_TYPE(t, file?.name || tr(t, 'studio_apps_edit.composer_images.that_file', 'That file')) };

    const bytes = dataUrlBytes(read.dataUrl);
    if (bytes > MAX_IMAGE_BYTES) {
        return { error: tr(t, 'studio_apps_edit.composer_images.too_large', '{name} is too large ({size} MB) — the limit is {max} MB.', { name, size: (bytes / (1024 * 1024)).toFixed(1), max: Math.round(MAX_IMAGE_BYTES / (1024 * 1024)) }) };
    }
    seq += 1;
    return { image: { id: `img_${seq}`, dataUrl: read.dataUrl, name: file?.name || tr(t, 'studio_apps_edit.composer_images.pasted_image', 'Pasted image'), mimeType: read.mimeType, bytes } };
}

/**
 * Turn pasted/dropped/picked files into staged composer images.
 *
 * → { images: [{ id, dataUrl, name, mimeType, bytes }], errors: [string] }
 * Never throws: a file that cannot be read becomes an error line, and the rest
 * still stage.
 */
export async function prepareComposerImages(files, alreadyStaged = 0, t = null) {
    const list = Array.from(files || []);
    const images = [];
    const errors = [];
    const room = Math.max(0, MAX_IMAGES_PER_TURN - alreadyStaged);
    if (!list.length) return { images, errors };
    if (room === 0) {
        return { images, errors: [tr(t, 'studio_apps_edit.composer_images.at_most', 'You can attach at most {max} images per message.', { max: MAX_IMAGES_PER_TURN })] };
    }
    if (list.length > room) {
        errors.push(room === 1
            ? tr(t, 'studio_apps_edit.composer_images.only_first_one', 'Only the first image was attached — the limit is {max} per message.', { max: MAX_IMAGES_PER_TURN })
            : tr(t, 'studio_apps_edit.composer_images.only_first_many', 'Only the first {room} images were attached — the limit is {max} per message.', { room, max: MAX_IMAGES_PER_TURN }));
    }

    for (const file of list.slice(0, room)) {
        const result = await stageOne(file, t);
        if (result.error) errors.push(result.error);
        else images.push(result.image);
    }
    return { images, errors };
}

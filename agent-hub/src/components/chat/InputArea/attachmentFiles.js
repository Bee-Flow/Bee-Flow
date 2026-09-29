/**
 * A picked file becomes an ATTACHMENT here, and nowhere else.
 *
 * Three call sites hand this module a list of `File`s — the hidden file input,
 * a drop on the composer, and a paste — and all three want the same record
 * back: name, mime type, byte size, and the content as a data URL the send can
 * carry. Images go through `resizeImageForUpload` first, so a phone photo does
 * not arrive as eight megabytes of JPEG; a resize that fails falls back to the
 * original rather than dropping the file.
 *
 * The 20MB cap is enforced here for the same reason: it is a property of "what
 * may be attached", not of the button that happened to be clicked.
 */
import { resizeImageForUpload, readAsDataUrl } from '../../../utils/imageResize';

/**
 * Turn a list of File objects into attachment records, skipping anything over
 * the size cap. Returns a (possibly empty) array — the caller decides what to
 * do with it.
 */
export async function buildAttachments(files) {
    const newAttachments = [];

    for (const file of files) {
        // Limit file size to 20MB
        if (file.size > 20 * 1024 * 1024) {
            console.warn(`File ${file.name} is too large (${(file.size / 1024 / 1024).toFixed(1)}MB), max 20MB`);
            continue;
        }

        let content;
        let finalType = file.type || 'application/octet-stream';
        let finalSize = file.size;

        if (file.type && file.type.startsWith('image/')) {
            try {
                const resized = await resizeImageForUpload(file);
                content = resized.dataUrl;
                finalType = resized.mimeType;
                finalSize = resized.resizedSize;
            } catch (err) {
                console.warn(`Image resize failed for ${file.name}, using original:`, err);
                content = await readAsDataUrl(file);
            }
        } else {
            content = await readAsDataUrl(file);
        }

        newAttachments.push({
            name: file.name,
            type: finalType,
            size: finalSize,
            content,
        });
    }

    return newAttachments;
}

/** Bytes as something a person reads without counting zeroes. */
export function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

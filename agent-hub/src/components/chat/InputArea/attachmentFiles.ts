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
 * The size cap is enforced here for the same reason: it is a property of "what
 * may be attached", not of the button that happened to be clicked.
 */
import { resizeImageForUpload, readAsDataUrl } from '@/utils/imageResize';

export interface Attachment {
    name: string;
    type: string;
    size: number;
    content: string;
}

/**
 * Raw size cap per file. The file travels as base64 (4/3 of its size) inside
 * the JSON turn body, which the server accepts up to 20 MB: 14.5 MB raw is
 * about 19.3 MB on the wire, with room for the message and history.
 */
export const MAX_ATTACHMENT_BYTES = Math.floor(14.5 * 1024 * 1024);

/** The cap as the number a person reads in a notice ("14.5 MB"). */
export const MAX_ATTACHMENT_MB = '14.5';

/**
 * Turn a list of File objects into attachment records, skipping anything over
 * the size cap. Returns a (possibly empty) array; `onTooLarge` is told about
 * every skipped file so the caller can say so, instead of the file vanishing.
 */
export async function buildAttachments(files: Iterable<File>, onTooLarge?: (file: File) => void): Promise<Attachment[]> {
    const newAttachments: Attachment[] = [];

    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
            onTooLarge?.(file);
            continue;
        }

        let content: string;
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
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

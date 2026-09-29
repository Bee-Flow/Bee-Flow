/**
 * Turning a picked file into what the chat endpoint actually accepts.
 *
 * There is NO chat-attachment upload endpoint. Attachments travel inline in the
 * turn's JSON body as `{name, type, size, content}` where `content` is a base64
 * data URL, and Express's body limit is 20 MB for the whole request
 * (server/index.js). Two photos straight off a modern phone camera are 8-12 MB
 * each, so an unresized attach is not an edge case — it is the normal case, and
 * it fails the whole turn rather than just the attachment.
 *
 * So this module does three things the web client also does, in order:
 *   1. resizes images to a sane long edge before encoding;
 *   2. refuses anything still too large, with a message naming the file;
 *   3. keeps a running total across the staged set, because the limit is on the
 *      request, not on each file.
 */

import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { Attachment } from './types';

/**
 * The server's bodyParser limit is 20 MB. Base64 inflates by ~4/3, and the
 * message, history and settings share the body, so the usable budget for
 * attachment bytes is well under that. 12 MB of raw bytes ≈ 16 MB encoded,
 * which leaves room for a long conversation history.
 */
export const TOTAL_ATTACHMENT_BUDGET = 12 * 1024 * 1024;

/** Per-file ceiling, matching the web client's own cap. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Long edge for a resized photo. 1568px is the largest dimension the vision
 * models actually use; anything beyond it is bytes spent for no accuracy.
 */
const IMAGE_LONG_EDGE = 1568;
const IMAGE_QUALITY = 0.8;

export class AttachmentTooLargeError extends Error {
    constructor(name: string) {
        super(`${name} is too large to send. Try a smaller file.`);
        this.name = 'AttachmentTooLargeError';
    }
}

export class AttachmentBudgetError extends Error {
    constructor() {
        super('Those attachments are too large to send together. Remove one and try again.');
        this.name = 'AttachmentBudgetError';
    }
}

function isImage(mimeType?: string): boolean {
    return Boolean(mimeType?.startsWith('image/'));
}

/**
 * Shrink an image if it is bigger than the model can use.
 *
 * Returns the original uri unchanged when the file is already small — a
 * needless re-encode costs a second of the user's time and loses quality.
 */
async function shrinkImage(uri: string, size?: number): Promise<{ uri: string; size?: number }> {
    if (size !== undefined && size < 400 * 1024) return { uri, size };
    try {
        const context = ImageManipulator.manipulate(uri);
        context.resize({ width: IMAGE_LONG_EDGE });
        const image = await context.renderAsync();
        const result = await image.saveAsync({ compress: IMAGE_QUALITY, format: SaveFormat.JPEG });
        const file = new File(result.uri);
        return { uri: result.uri, size: file.exists ? file.size : undefined };
    } catch {
        // A HEIC the manipulator cannot open, or an out-of-memory on a very
        // large image. Fall back to the original and let the size check below
        // reject it with a message the user can act on.
        return { uri, size };
    }
}

/**
 * Read a staged attachment into the inline form the endpoint expects.
 *
 * `content` is a full data URL (`data:image/jpeg;base64,…`), matching what the
 * web client produces with FileReader.readAsDataURL — the server splits on the
 * comma, so a bare base64 payload would be silently misread.
 */
export async function encodeAttachment(attachment: Attachment): Promise<Attachment> {
    if (attachment.dataUrl) return attachment;
    if (!attachment.uri) throw new Error(`${attachment.name} has no file to read.`);

    let uri = attachment.uri;
    let size = attachment.size;

    if (isImage(attachment.mimeType)) {
        const shrunk = await shrinkImage(uri, size);
        uri = shrunk.uri;
        size = shrunk.size;
    }

    if (size !== undefined && size > MAX_FILE_BYTES) {
        throw new AttachmentTooLargeError(attachment.name);
    }

    const base64 = await new File(uri).base64();
    const mimeType = isImage(attachment.mimeType)
        ? // shrinkImage always writes JPEG; claiming the original type would
          // mislabel a converted HEIC.
          uri === attachment.uri
          ? (attachment.mimeType ?? 'image/jpeg')
          : 'image/jpeg'
        : (attachment.mimeType ?? 'application/octet-stream');

    return {
        ...attachment,
        size: size ?? Math.floor((base64.length * 3) / 4),
        mimeType,
        dataUrl: `data:${mimeType};base64,${base64}`,
    };
}

/**
 * Encode the whole staged set, enforcing the shared request budget.
 *
 * Sequential rather than parallel on purpose: encoding several multi-megabyte
 * images at once is the most reliable way to OOM a mid-range Android device,
 * and the user is waiting on the slowest one either way.
 */
export async function encodeAttachments(attachments: Attachment[]): Promise<Attachment[]> {
    const encoded: Attachment[] = [];
    let total = 0;
    for (const attachment of attachments) {
        const one = await encodeAttachment(attachment);
        total += one.size ?? 0;
        if (total > TOTAL_ATTACHMENT_BUDGET) throw new AttachmentBudgetError();
        encoded.push(one);
    }
    return encoded;
}

/** The wire shape. The server reads `content`, not `dataUrl`. */
export interface WireAttachment {
    name: string;
    type: string;
    size: number;
    content: string;
}

export function toWire(attachments: Attachment[]): WireAttachment[] {
    return attachments
        .filter((a): a is Attachment & { dataUrl: string } => Boolean(a.dataUrl))
        .map((a) => ({
            name: a.name,
            type: a.mimeType ?? 'application/octet-stream',
            size: a.size ?? 0,
            content: a.dataUrl,
        }));
}


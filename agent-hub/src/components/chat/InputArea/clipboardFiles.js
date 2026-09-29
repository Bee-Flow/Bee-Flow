/**
 * Getting FILES out of a paste, across browsers that disagree about where they
 * put them.
 *
 * Three routes, tried in the order the composer tries them, because each one
 * covers a case the previous one cannot see:
 *
 *   1. `clipboardData.items` — Chrome, Edge, and most of the rest.
 *   2. `clipboardData.files` — Firefox's fallback for the same paste.
 *   3. an <img> inside `text/html` — what you get when an image is copied off
 *      a web page rather than from a file manager.
 *
 * And a fourth, asynchronous one: on Linux/Wayland a screenshot reaches the
 * page only through `navigator.clipboard.read()`, with `clipboardData.items`
 * arriving empty. That is what `clipboardMayHaveImage` exists to recognise —
 * an empty items list is a signal there, not the absence of one.
 *
 * Nothing here touches React: these are the browser half of the paste, kept
 * separate from the composer's wiring in usePasteAttachments.js so the quirks
 * above can be read (and corrected) on their own.
 */
import { logger } from '../../../utils/logger';

/** Extract files from clipboardData (sync — classic approach) */
export function extractPasteFiles(clipboardData) {
    if (!clipboardData) return [];
    const files = [];

    // Method 1: clipboardData.items (Chrome, Edge, most browsers)
    const items = Array.from(clipboardData.items || []);
    for (const item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
                if (file.type.startsWith('image/') && (!file.name || file.name === 'image.png')) {
                    const ext = file.type.split('/')[1] || 'png';
                    files.push(new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type }));
                } else {
                    files.push(file);
                }
            }
        }
    }

    // Method 2: clipboardData.files fallback (Firefox)
    if (files.length === 0) {
        const clipFiles = Array.from(clipboardData.files || []);
        for (const file of clipFiles) {
            if (file.type.startsWith('image/')) {
                const ext = file.type.split('/')[1] || 'png';
                files.push(new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type }));
            } else {
                files.push(file);
            }
        }
    }

    return files;
}

/** Extract image from HTML clipboard data (e.g. images copied from web pages) */
export async function extractImageFromHtml(clipboardData) {
    if (!clipboardData) return null;
    const items = Array.from(clipboardData.items || []);
    const htmlItem = items.find(i => i.kind === 'string' && i.type === 'text/html');
    if (!htmlItem) return null;

    const html = await new Promise(resolve => htmlItem.getAsString(resolve));
    // Look for <img> tags with data URLs or http URLs
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!imgMatch) return null;

    const src = imgMatch[1];
    try {
        if (src.startsWith('data:image/')) {
            // Base64 data URL — convert to File
            const res = await fetch(src);
            const blob = await res.blob();
            const ext = blob.type.split('/')[1] || 'png';
            return new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: blob.type });
        } else if (src.startsWith('http')) {
            // Try to fetch the remote image
            const res = await fetch(src);
            if (res.ok) {
                const blob = await res.blob();
                if (blob.type.startsWith('image/')) {
                    const ext = blob.type.split('/')[1] || 'png';
                    return new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: blob.type });
                }
            }
        }
    } catch (err) {
        console.warn('[Paste] Failed to extract image from HTML:', err);
    }
    return null;
}

/** Async fallback using navigator.clipboard.read() (works on Linux/Wayland where clipboardData is empty) */
export async function readClipboardAsync() {
    if (!navigator.clipboard?.read) {
        logger.debug('[Paste] navigator.clipboard.read not available');
        return [];
    }
    try {
        const clipboardItems = await navigator.clipboard.read();
        const files = [];
        for (const item of clipboardItems) {
            for (const type of item.types) {
                if (type.startsWith('image/')) {
                    const blob = await item.getType(type);
                    const ext = type.split('/')[1] || 'png';
                    files.push(new File([blob], `pasted-image-${Date.now()}.${ext}`, { type }));
                }
            }
        }
        logger.debug(`[Paste] navigator.clipboard.read() found ${files.length} image(s)`);
        return files;
    } catch (err) {
        console.warn('[Paste] navigator.clipboard.read() failed:', err.message);
        return [];
    }
}

/** Check if clipboard might contain image data (even if not directly accessible sync) */
export function clipboardMayHaveImage(clipboardData) {
    if (!clipboardData) return false;
    const items = Array.from(clipboardData.items || []);
    // Check for any image type in items
    for (const item of items) {
        if (item.type.startsWith('image/')) return true;
    }
    // Also check files list
    const clipFiles = Array.from(clipboardData.files || []);
    if (clipFiles.some(f => f.type.startsWith('image/'))) return true;
    // On Linux/Wayland, screenshot images are only accessible via the async
    // navigator.clipboard.read() API — clipboardData.items will be empty.
    // Text paste on the same systems DOES populate items with text/plain,
    // so empty items reliably signals a potential screenshot, not plain text.
    if (items.length === 0 && clipFiles.length === 0) return true;
    return false;
}

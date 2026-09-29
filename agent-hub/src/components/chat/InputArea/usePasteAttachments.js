/**
 * PASTE, wired to the composer.
 *
 * Two listeners, not one, and the split is the whole point. The textarea's own
 * `onPaste` catches a paste while the caret is in the box; the document-level
 * listener catches Ctrl+V when focus is anywhere else on the page, which is
 * where a screenshot usually lands — you take it, you click back into the
 * chat, and nothing has focus yet. The document handler stands down the moment
 * an input, a textarea or a contenteditable owns the caret, so it can never
 * steal a paste from a field that wanted it.
 *
 * Both walk the same escalation, from `clipboardFiles.js`: sync items, then an
 * <img> out of `text/html`, then the async clipboard API. `preventDefault()`
 * is called BEFORE the async hop rather than after — awaiting first lets the
 * textarea insert whatever text the clipboard also carried, and the file then
 * arrives next to a line of garbage.
 *
 * The permission probe in front of the async route is not caution for its own
 * sake: with clipboard-read denied, `navigator.clipboard.read()` rejects, and
 * a paste that was already prevented would come back with nothing at all —
 * plain text silently lost. Denied means: do not prevent, let the text land.
 */
import { useCallback, useEffect } from 'react';

import { logger } from '../../../utils/logger';

import {
    clipboardMayHaveImage,
    extractImageFromHtml,
    extractPasteFiles,
    readClipboardAsync,
} from './clipboardFiles';

/**
 * @param {object}   args
 * @param {Function} args.processFiles  attach these File objects
 * @param {object}   args.textareaRef   the composer's textarea, refocused after
 *                                      a paste the document handler caught
 * @returns {Function} the textarea's onPaste handler
 */
export default function usePasteAttachments({ processFiles, textareaRef }) {
    const handlePaste = useCallback(async (e) => {
        logger.debug('[Paste] Paste event fired. Items:', e.clipboardData?.items?.length, 'Files:', e.clipboardData?.files?.length);

        // Try sync extraction first (fastest, works on most browsers)
        let files = extractPasteFiles(e.clipboardData);

        if (files.length > 0) {
            logger.debug('[Paste] Sync extraction found', files.length, 'file(s)');
            e.preventDefault();
            await processFiles(files);
            return;
        }

        // Try extracting image from HTML clipboard (copied from web pages)
        const htmlImage = await extractImageFromHtml(e.clipboardData);
        if (htmlImage) {
            logger.debug('[Paste] HTML image extraction succeeded');
            e.preventDefault();
            await processFiles([htmlImage]);
            return;
        }

        // Async fallback: navigator.clipboard.read() for Linux/Wayland screenshots
        // This fires when the sync clipboardData shows image MIME types but getAsFile()
        // returns null (a known Wayland/browser quirk).
        // We also try if items has explicit image types but sync extraction somehow missed them.
        const hasClipboardAPI = !!navigator.clipboard?.read;
        const maybeImage = clipboardMayHaveImage(e.clipboardData);

        if (hasClipboardAPI && maybeImage) {
            logger.debug('[Paste] Trying async clipboard API (Linux/Wayland screenshot fallback)');
            // Check permission first to avoid blocking text paste if denied
            let permissionOk = true;
            try {
                const perm = await navigator.permissions.query({ name: 'clipboard-read' });
                if (perm.state === 'denied') {
                    console.warn('[Paste] clipboard-read permission denied — skipping async API, letting text paste proceed');
                    permissionOk = false;
                }
            } catch (_) { /* permissions API not available — proceed optimistically */ }

            if (permissionOk) {
                // Must preventDefault BEFORE the async call to avoid the textarea inserting garbage
                e.preventDefault();
                files = await readClipboardAsync();
                if (files.length > 0) {
                    await processFiles(files);
                } else {
                    logger.debug('[Paste] Async clipboard API returned no images');
                }
            }
        }
        // If none of the above matched, let the default paste behavior handle it (text paste)
    }, [processFiles]);

    // Document-level paste listener (catches pastes ONLY when textarea doesn't have focus)
    useEffect(() => {
        const onDocumentPaste = async (e) => {
            if (!textareaRef.current) return;
            const activeEl = document.activeElement;
            // If the textarea has focus, its own onPaste handler already handles it — skip
            if (activeEl === textareaRef.current) return;
            // Skip other inputs/textareas too
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) return;

            logger.debug('[Paste/Doc] Document paste event. Items:', e.clipboardData?.items?.length, 'Files:', e.clipboardData?.files?.length);

            let files = extractPasteFiles(e.clipboardData);
            if (files.length > 0) {
                e.preventDefault();
                await processFiles(files);
                textareaRef.current?.focus();
                return;
            }

            // HTML image fallback
            const htmlImage = await extractImageFromHtml(e.clipboardData);
            if (htmlImage) {
                e.preventDefault();
                await processFiles([htmlImage]);
                textareaRef.current?.focus();
                return;
            }

            // Async clipboard API fallback — only if items explicitly show image types
            if (clipboardMayHaveImage(e.clipboardData) && navigator.clipboard?.read) {
                let permissionOk = true;
                try {
                    const perm = await navigator.permissions.query({ name: 'clipboard-read' });
                    if (perm.state === 'denied') permissionOk = false;
                } catch (_) { /* proceed */ }

                if (permissionOk) {
                    e.preventDefault();
                    files = await readClipboardAsync();
                    if (files.length > 0) {
                        await processFiles(files);
                        textareaRef.current?.focus();
                    }
                }
            }
        };

        document.addEventListener('paste', onDocumentPaste);
        return () => document.removeEventListener('paste', onDocumentPaste);
    }, [processFiles, textareaRef]);

    return handlePaste;
}

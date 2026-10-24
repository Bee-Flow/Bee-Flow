import { logger } from './logger';
// One clipboard helper: the async Clipboard API first, `execCommand('copy')`
// on a throwaway textarea when that API is missing (plain HTTP, older
// browsers, some embedded iframes).
//
// `copyText` RESOLVES when the text was copied and REJECTS otherwise, so a
// caller keeps its own feedback (a "Copied" flag, a toast, an error message
// built from the rejection's `message`).
//
// Failure modes, in the order a caller can see them:
//   - the Clipboard API rejects: that rejection is passed on unchanged,
//     unless `fallbackOnReject` is set, in which case the legacy path runs next;
//   - `execCommand('copy')` returns false: rejects with `Error(failMessage)`
//     (default 'copy failed');
//   - the legacy path throws (no DOM, write-protected document): that error.

export interface CopyTextOptions {
    /** Run the legacy path after the Clipboard API rejected, not only when the API is missing. */
    fallbackOnReject?: boolean;
    /** Focus the textarea before selecting it (some embedded iframes need it). */
    focus?: boolean;
    /** Message of the Error thrown when `execCommand('copy')` reports failure. */
    failMessage?: string;
}

function legacyCopy(text: string, focus: boolean, failMessage: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    if (focus) ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error(failMessage);
}

export async function copyText(text: string, opts: CopyTextOptions = {}): Promise<void> {
    const { fallbackOnReject = false, focus = false, failMessage = 'copy failed' } = opts;
    if (navigator.clipboard?.writeText) {
        if (!fallbackOnReject) {
            await navigator.clipboard.writeText(text);
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (err) { logger.debug('fall through to the legacy copy', err); }
    }
    legacyCopy(text, focus, failMessage);
}

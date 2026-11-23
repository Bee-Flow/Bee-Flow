// Print opens the rendered PDF in a tab of its own. A browser only lets a page open a tab while the click
// that asked for it is still being handled, and the PDF takes seconds to render: so the tab is opened
// first, empty, and the PDF is put into it once it is there. When the browser refused the tab anyway, the
// caller downloads the PDF instead of failing in silence.

import { logger } from '@/utils/logger';

const PRINT_URL_TTL_MS = 60_000;

/** An empty tab for the PDF, or null when the browser blocks it. Call it before the first await. */
export function openPrintTab(): Window | null {
    try { return window.open('', '_blank'); } catch (err) { logger.debug('no tab for the PDF', err); return null; }
}

/** The rendered PDF into the tab opened for it. */
export function showInPrintTab(tab: Window, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), PRINT_URL_TTL_MS);
}

/** The tab is not needed (the render failed): close it rather than leave a blank one behind. */
export function closePrintTab(tab: Window | null): void {
    try { if (tab && !tab.closed) tab.close(); } catch (err) { logger.debug('the tab is the browser\'s now', err); }
}

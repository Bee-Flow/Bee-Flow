import type { PdfDocHandle } from './pdfTypes';

/**
 * Stand-in for pdfEngine.ts in the headless screenshot bundle: that page has no
 * network and no worker, and bundling pdf.js would add ~1 MB to a file that is
 * served on every render. The component shows a clean placeholder on this error.
 */
export async function openPdf(_data: ArrayBuffer): Promise<PdfDocHandle> {
    throw new Error('pdf rendering is not available in this environment');
}

export const isRenderCancelled = (_err: unknown): boolean => false;

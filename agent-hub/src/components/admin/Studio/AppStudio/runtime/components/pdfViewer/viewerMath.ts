import { clampZoom } from '../pdfCompare/pdfCompareMath';

/** How the page width follows the pane: fill its width, fit the whole page in it, or a fixed multiple of fill-width. */
export type FitMode = 'width' | 'page' | 'custom';

export const FALLBACK_ASPECT = 1.414;

export const nextRotation = (r: number): number => (r + 90) % 360;

/** Height / width of a page after turning it `rotation` degrees. */
export function turnedAspect(aspect: number, rotation: number): number {
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : FALLBACK_ASPECT;
    return rotation % 180 === 0 ? a : 1 / a;
}

/** CSS width for every page, from the pane's inner size and the first page's (turned) aspect. */
export function viewerPageWidth(mode: FitMode, zoom: number, paneW: number, paneH: number, aspect: number): number {
    if (paneW < 1) return 0;
    if (mode === 'page') return Math.max(1, Math.floor(Math.min(paneW, paneH > 0 ? paneH / aspect : paneW)));
    if (mode === 'width') return Math.floor(paneW);
    return Math.max(1, Math.floor(paneW * clampZoom(zoom)));
}

/** The page whose top is the last one above `probe` (a y offset in the scroller's content). */
export function pageAtOffset(tops: number[], probe: number): number {
    let found = 1;
    for (let i = 0; i < tops.length; i += 1) {
        if (tops[i] <= probe) found = i + 1;
        else break;
    }
    return found;
}

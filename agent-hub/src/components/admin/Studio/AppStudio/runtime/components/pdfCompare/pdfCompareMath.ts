/**
 * Pure maths for the pdf_compare component: zoom/fit, scroll sync and the
 * pixel diff that finds the changed regions. No DOM, no pdf.js — everything
 * here is unit-tested with plain arrays.
 */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;

/** Zoom is a multiplier on "fit width": 1 = the page exactly fills the pane. */
export function clampZoom(z: number): number {
    if (!Number.isFinite(z)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function stepZoom(z: number, dir: 1 | -1): number {
    const next = dir > 0 ? z * ZOOM_STEP : z / ZOOM_STEP;
    // Snap onto exactly 1 so "fit" is reachable by stepping back.
    return Math.abs(next - 1) < 0.04 ? 1 : clampZoom(Math.round(next * 1000) / 1000);
}

/** CSS width of the page for a pane of `paneWidth` px at `zoom`. */
export function pageCssWidth(paneWidth: number, zoom: number): number {
    return Math.max(1, Math.floor(paneWidth * clampZoom(zoom)));
}

export function clampPage(page: number, numPages: number): number {
    if (numPages < 1) return 1;
    return Math.min(numPages, Math.max(1, Math.round(page) || 1));
}

/** Scroll position as a 0..1 ratio, so panes of different size stay in step. */
export function scrollRatio(pos: number, scrollSize: number, clientSize: number): number {
    const max = scrollSize - clientSize;
    return max <= 0 ? 0 : Math.min(1, Math.max(0, pos / max));
}

export function scrollFromRatio(ratio: number, scrollSize: number, clientSize: number): number {
    const max = scrollSize - clientSize;
    return max <= 0 ? 0 : Math.round(ratio * max);
}

export function clampPercent(p: number): number {
    return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 50;
}

// ── diff ────────────────────────────────────────────────────────────────

export interface PixelImage { data: ArrayLike<number>; width: number; height: number }

/** A changed region in page-relative units (0..1), independent of zoom. */
export interface ChangeRegion { x: number; y: number; w: number; h: number }

export interface DiffOptions {
    /** Luminance difference (0..255) a pixel needs to count as changed. */
    threshold?: number;
    /** Cell size in px for the coarse grid the regions are grown on. */
    cell?: number;
    /** Cells of gap that still merge two marks into one region. */
    gapCells?: number;
    /** Padding around each box, in cells. */
    padCells?: number;
    /** Cells with fewer changed pixels than this are anti-aliasing noise. */
    minPixelsPerCell?: number;
    /** Regions smaller than this many cells (area) are dropped. */
    minRegionCells?: number;
    maxRegions?: number;
}

const lum = (d: ArrayLike<number>, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

interface Grid { cols: number; rows: number; cell: number; width: number; height: number }

/** Count, per grid cell, the pixels whose luminance differs by more than `threshold`. */
function countChangedPixels(a: PixelImage, b: PixelImage, g: Grid, threshold: number): Uint16Array {
    const counts = new Uint16Array(g.cols * g.rows);
    for (let y = 0; y < g.height; y++) {
        const rowBase = Math.floor(y / g.cell) * g.cols;
        for (let x = 0; x < g.width; x++) {
            const d = lum(a.data, (y * a.width + x) * 4) - lum(b.data, (y * b.width + x) * 4);
            if (Math.abs(d) > threshold) counts[rowBase + Math.floor(x / g.cell)]++;
        }
    }
    return counts;
}

/** Spread every marked cell over its (2r+1)² neighbourhood, so nearby marks fuse. */
function dilate(marked: Uint8Array, g: Grid, radius: number): Uint8Array {
    const grown = new Uint8Array(marked.length);
    for (let i = 0; i < marked.length; i++) {
        if (!marked[i]) continue;
        const r = Math.floor(i / g.cols), c = i % g.cols;
        const r1 = Math.min(g.rows - 1, r + radius), c1 = Math.min(g.cols - 1, c + radius);
        for (let rr = Math.max(0, r - radius); rr <= r1; rr++) {
            grown.fill(1, rr * g.cols + Math.max(0, c - radius), rr * g.cols + c1 + 1);
        }
    }
    return grown;
}

interface Box { minC: number; maxC: number; minR: number; maxR: number; marked: number }

/** Flood-fill one 8-connected component of `grown`, returning the bounds of its MARKED cells. */
function floodComponent(start: number, grown: Uint8Array, marked: Uint8Array, seen: Uint8Array, g: Grid): Box {
    const box: Box = { minC: g.cols, maxC: -1, minR: g.rows, maxR: -1, marked: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
        const i = stack.pop() as number;
        const r = Math.floor(i / g.cols), c = i % g.cols;
        if (marked[i]) {
            box.marked++;
            box.minC = Math.min(box.minC, c); box.maxC = Math.max(box.maxC, c);
            box.minR = Math.min(box.minR, r); box.maxR = Math.max(box.maxR, r);
        }
        pushNeighbours(i, grown, seen, g, stack);
    }
    return box;
}

function pushNeighbours(i: number, grown: Uint8Array, seen: Uint8Array, g: Grid, stack: number[]): void {
    const r = Math.floor(i / g.cols), c = i % g.cols;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(g.rows - 1, r + 1); rr++) {
        for (let cc = Math.max(0, c - 1); cc <= Math.min(g.cols - 1, c + 1); cc++) {
            const j = rr * g.cols + cc;
            if (grown[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
    }
}

function boxToRegion(box: Box, g: Grid, pad: number): ChangeRegion {
    const x0 = Math.max(0, (box.minC - pad) * g.cell);
    const y0 = Math.max(0, (box.minR - pad) * g.cell);
    const x1 = Math.min(g.width, (box.maxC + 1 + pad) * g.cell);
    const y1 = Math.min(g.height, (box.maxR + 1 + pad) * g.cell);
    return { x: x0 / g.width, y: y0 / g.height, w: (x1 - x0) / g.width, h: (y1 - y0) / g.height };
}

const DIFF_DEFAULTS: Required<DiffOptions> = { threshold: 40, cell: 8, gapCells: 3, padCells: 1, minPixelsPerCell: 2, minRegionCells: 1, maxRegions: 200 };

/**
 * Compare two same-size renderings and return merged bounding boxes.
 *
 * Pixels differing by more than `threshold` mark a cell of the coarse grid;
 * marked cells are merged across `gapCells` (so one removed name, whose letters
 * are separate marks, is ONE box, not dozens) and padded. Single noisy pixels
 * from anti-aliasing never reach `minPixelsPerCell`.
 */
export function diffRegions(a: PixelImage, b: PixelImage, opts: DiffOptions = {}): ChangeRegion[] {
    const { threshold, cell, gapCells, padCells, minPixelsPerCell, minRegionCells, maxRegions } = { ...DIFF_DEFAULTS, ...opts };
    const width = Math.min(a.width, b.width);
    const height = Math.min(a.height, b.height);
    if (width < 1 || height < 1) return [];
    const g: Grid = { cols: Math.ceil(width / cell), rows: Math.ceil(height / cell), cell, width, height };
    const counts = countChangedPixels(a, b, g, threshold);
    const marked = Uint8Array.from(counts, (n) => (n >= minPixelsPerCell ? 1 : 0));
    const grown = dilate(marked, g, gapCells);
    const seen = new Uint8Array(grown.length);
    const out: ChangeRegion[] = [];
    for (let start = 0; start < grown.length; start++) {
        if (!grown[start] || seen[start]) continue;
        const box = floodComponent(start, grown, marked, seen, g);
        if (box.maxC >= 0 && box.marked >= minRegionCells) out.push(boxToRegion(box, g, padCells));
    }
    // Reading order: top to bottom, then left to right.
    out.sort((p, q) => (p.y - q.y) || (p.x - q.x));
    return out.slice(0, maxRegions);
}

/** Position of a region as CSS percentages (alignment survives any zoom). */
export function regionStyle(r: ChangeRegion): { left: string; top: string; width: string; height: string } {
    return { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };
}

/** Do two pages have the same shape (within 2%)? Otherwise a pixel diff is meaningless. */
export function sameGeometry(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
    if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return false;
    return Math.abs(a.width / a.height - b.width / b.height) / (a.width / a.height) < 0.02;
}

/** The next change after (page, index), wrapping around; null when there is none at all. */
export function nextChange(
    byPage: Record<number, ChangeRegion[] | undefined>, numPages: number, page: number, index: number, dir: 1 | -1 = 1,
): { page: number; index: number } | null {
    const flat: Array<{ page: number; index: number }> = [];
    for (let p = 1; p <= numPages; p++) (byPage[p] || []).forEach((_, i) => flat.push({ page: p, index: i }));
    if (!flat.length) return null;
    const cur = flat.findIndex((f) => f.page === page && f.index === index);
    if (cur >= 0) return flat[(cur + dir + flat.length) % flat.length];
    if (dir > 0) return flat.find((f) => f.page > page || (f.page === page && f.index > index)) || flat[0];
    const before = flat.filter((f) => f.page < page || (f.page === page && f.index < index));
    return before.length ? before[before.length - 1] : flat[flat.length - 1];
}

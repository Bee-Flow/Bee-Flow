/**
 * Enlarged crops of a technical-drawing PDF for the vision model (forced
 * 'images' mode only).
 *
 * A drawing page rendered whole lands at ~1568 px on the long edge. On A3/A2
 * the title block is then a few pixels high, and GPT-style hosts shrink a
 * high-detail image further. So next to the overview we send the title block
 * and the page in 2x2 tiles, each rendered so ITS long edge is ~1568 px.
 *
 * Budget: at most 3 pages, at most 6 images per page (overview + title block +
 * 4 tiles), and never past `maxImages` (the remaining room under the request's
 * MAX_TOTAL_DOC_IMAGES, enforced by the caller in appStudio/aiRuntime.js).
 * When room is short the order of preference is overview > title block >
 * tiles, earlier pages first.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const CROP_MAX_PAGES = 3;
/** Crop room used when the caller passes no request-wide limit (3 pages x 5). */
export const DEFAULT_CROP_BUDGET = CROP_MAX_PAGES * 5;
export const CROP_LONG_EDGE = 1568;
// A page whose text layer is thinner than this is drawing-like (CAD export,
// scan); a dense A4 text document keeps its text and needs no crops. Anything
// larger than A4 is a drawing sheet even when its title block has real text,
// because the small print is what a downscaled overview loses.
const SHORT_TEXT_CHARS = 200;
const A4_AREA_PT = 595 * 842;

export type PageSize = { pageNumber: number; width: number; height: number };
export type CropRequest = { pageNumber: number; label: string; x: number; y: number; w: number; h: number };
export type CropImage = { base64: string; mimeType: 'image/png'; label?: string; width?: number; height?: number };
type Rendered = { pageNumber: number; label: string; base64: string; mimeType: 'image/png'; width?: number; height?: number };
type RenderFn = (buf: Buffer, opts: { maxPages: number; targetLongEdge: number; filename?: string; plan: (p: PageSize[]) => CropRequest[] }) => Promise<Rendered[] | null>;

// Title block bottom-right; tiles overlap by 10% of the page on each axis.
const TITLE = { label: 'Title block (enlarged)', x: 0.55, y: 0.7, w: 0.45, h: 0.3 };
const TILES = [
    { label: 'Tile top-left', x: 0, y: 0 },
    { label: 'Tile top-right', x: 0.45, y: 0 },
    { label: 'Tile bottom-left', x: 0, y: 0.45 },
    { label: 'Tile bottom-right', x: 0.45, y: 0.45 },
].map((t) => ({ ...t, w: 0.55, h: 0.55 }));

export function isDrawingLikePage(page: PageSize, chars: number): boolean {
    return chars < SHORT_TEXT_CHARS || page.width * page.height > A4_AREA_PT * 1.1;
}

function pageLabel(base: string, pageNumber: number, multi: boolean): string {
    return multi ? `Page ${pageNumber} — ${base}` : base;
}

/** What to render, in output order (page, then title block, then tiles). */
export function planCrops(pages: PageSize[], pageCharCounts: number[], room: number, multi: boolean): CropRequest[] {
    const drawing = pages.filter((p) => isDrawingLikePage(p, pageCharCounts[p.pageNumber - 1] ?? 0)).slice(0, CROP_MAX_PAGES);
    const wanted: CropRequest[] = [];
    const rank = (kind: 'title' | 'tile') => (kind === 'title' ? 0 : 1);
    const all: Array<{ r: CropRequest; kind: 'title' | 'tile'; order: number }> = [];
    for (const p of drawing) {
        all.push({ r: { pageNumber: p.pageNumber, ...TITLE, label: pageLabel(TITLE.label, p.pageNumber, multi) }, kind: 'title', order: all.length });
        for (const t of TILES) all.push({ r: { pageNumber: p.pageNumber, ...t, label: pageLabel(t.label, p.pageNumber, multi) }, kind: 'tile', order: all.length });
    }
    const keep = new Set([...all].sort((a, b) => rank(a.kind) - rank(b.kind) || a.order - b.order).slice(0, Math.max(0, room)).map((c) => c.order));
    for (const c of all) if (keep.has(c.order)) wanted.push(c.r);
    return wanted;
}

/**
 * Add the crops after the overview images. Returns the original images and
 * a null legend whenever nothing was added (no room, no drawing-like page,
 * renderer unavailable): the caller's result is then unchanged.
 */
export async function addDrawingCrops(opts: {
    buffer: Buffer;
    images: Array<{ base64: string; mimeType: 'image/png' }>;
    totalPages: number;
    pageCharCounts: number[];
    maxImages?: number;
    filename?: string;
    render?: RenderFn;
}): Promise<{ images: CropImage[]; legend: string | null }> {
    const multi = opts.totalPages > 1;
    const overviews: CropImage[] = opts.images.map((img, i) => ({ ...img, label: pageLabel('Overview', i + 1, multi) }));
    const cap = opts.maxImages ?? Infinity;
    const room = Math.min(cap - overviews.length, DEFAULT_CROP_BUDGET);
    if (room <= 0) return { images: opts.images, legend: null };
    try {
        const render: RenderFn = opts.render ?? nodeRequire('./pdfToImages').renderPdfRegions;
        const crops = await render(opts.buffer, {
            maxPages: CROP_MAX_PAGES,
            targetLongEdge: CROP_LONG_EDGE,
            filename: opts.filename,
            plan: (pages) => planCrops(pages, opts.pageCharCounts, room, multi),
        });
        if (!crops || !crops.length) return { images: opts.images, legend: null };
        const images = [...overviews, ...crops.map(({ base64, mimeType, label, width, height }) => ({ base64, mimeType, label, width, height }))];
        const legend = 'Images, in order: ' + images.map((im, i) => `${i + 1} = ${im.label ?? 'Image'}`).join('; ') + '.';
        return { images, legend };
    } catch {
        return { images: opts.images, legend: null };
    }
}

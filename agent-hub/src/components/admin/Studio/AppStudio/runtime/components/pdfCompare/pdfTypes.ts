/** The small surface of pdf.js the pdf_compare and file_preview components need. */
export interface RenderJob { promise: Promise<void>; cancel(): void }

export interface PdfPageHandle {
    /** Page size in PDF points at scale 1. */
    width: number;
    height: number;
    /**
     * Paint the page onto `canvas` so it is `cssWidth` CSS px wide (sharp at `dpr`).
     * `rotation` (0/90/180/270) turns it on top of the page's own rotation; the
     * canvas then has the turned page's proportions.
     */
    render(canvas: HTMLCanvasElement, opts: { cssWidth: number; dpr: number; rotation?: number }): RenderJob;
    /**
     * Lay the page's text over `container` (transparent, selectable spans) at the
     * same size and rotation as `render`. Optional: only the document viewer uses it.
     */
    renderText?(container: HTMLElement, opts: { cssWidth: number; rotation?: number }): RenderJob;
}

export interface PdfDocHandle {
    numPages: number;
    getPage(n: number): Promise<PdfPageHandle>;
    destroy(): void;
}

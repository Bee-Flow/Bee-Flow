/** The small surface of pdf.js the pdf_compare component needs. */
export interface RenderJob { promise: Promise<void>; cancel(): void }

export interface PdfPageHandle {
    /** Page size in PDF points at scale 1. */
    width: number;
    height: number;
    /** Paint the page onto `canvas` so it is `cssWidth` CSS px wide (sharp at `dpr`). */
    render(canvas: HTMLCanvasElement, opts: { cssWidth: number; dpr: number }): RenderJob;
}

export interface PdfDocHandle {
    numPages: number;
    getPage(n: number): Promise<PdfPageHandle>;
    destroy(): void;
}

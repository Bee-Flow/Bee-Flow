import type { PdfDocHandle, PdfPageHandle, RenderJob } from './pdfTypes';

/**
 * pdf.js behind a three-method facade, loaded on first use so it stays out of
 * the main bundle. Everything pdf.js-shaped stays in this file; the component
 * and its tests only see ./pdfTypes. The headless screenshot bundle aliases
 * this module to pdfEngine.stub.ts (vite.runtime.config.js).
 */

type PdfJs = typeof import('pdfjs-dist');
let engine: Promise<PdfJs> | null = null;

function loadEngine(): Promise<PdfJs> {
    if (!engine) {
        engine = (async () => {
            const [pdfjs, worker] = await Promise.all([
                import('pdfjs-dist'),
                // `?worker`, not `?url`: Vite then emits the worker as a .js
                // chunk. A `?url` asset keeps its .mjs name, which nginx serves
                // as application/octet-stream; with nosniff the browser refuses
                // it as a module worker and every document fails to open.
                import('pdfjs-dist/build/pdf.worker.min.mjs?worker'),
            ]);
            // One port for every document: pdf.js reuses it across getDocument calls.
            if (!pdfjs.GlobalWorkerOptions.workerPort) {
                pdfjs.GlobalWorkerOptions.workerPort = new worker.default();
            }
            return pdfjs;
        })();
        // A failed load (offline chunk) must be retryable.
        engine.catch(() => { engine = null; });
    }
    return engine;
}

export async function openPdf(data: ArrayBuffer): Promise<PdfDocHandle> {
    const pdfjs = await loadEngine();
    // pdf.js transfers the buffer to its worker; hand it a copy so a retry or a second view still has bytes.
    const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
    const doc = await task.promise;
    return {
        numPages: doc.numPages,
        async getPage(n: number): Promise<PdfPageHandle> {
            const page = await doc.getPage(n);
            const base = page.getViewport({ scale: 1 });
            return {
                width: base.width,
                height: base.height,
                render(canvas, { cssWidth, dpr }): RenderJob {
                    const scale = (cssWidth * dpr) / base.width;
                    const viewport = page.getViewport({ scale });
                    canvas.width = Math.max(1, Math.floor(viewport.width));
                    canvas.height = Math.max(1, Math.floor(viewport.height));
                    canvas.style.width = `${cssWidth}px`;
                    canvas.style.height = `${Math.round((cssWidth * base.height) / base.width)}px`;
                    const job = page.render({ canvas, viewport });
                    return {
                        promise: job.promise.then(() => undefined),
                        cancel: () => job.cancel(),
                    };
                },
            };
        },
        destroy() { void task.destroy(); },
    };
}

export const isRenderCancelled = (err: unknown): boolean =>
    !!err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException';

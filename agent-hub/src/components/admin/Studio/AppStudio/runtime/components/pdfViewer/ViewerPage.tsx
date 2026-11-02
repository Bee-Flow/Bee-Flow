import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react';
import { isRenderCancelled } from '../pdfCompare/pdfEngine';
import type { PdfDocHandle, PdfPageHandle, RenderJob } from '../pdfCompare/pdfTypes';

const ROOT_MARGIN = '800px 0px';
const TEXT_LAYER = 'absolute inset-0 overflow-hidden leading-none [&_span]:absolute [&_span]:origin-top-left [&_span]:cursor-text [&_span]:whitespace-pre [&_span]:text-transparent [&_br]:hidden';

interface ViewerPageProps {
    doc: PdfDocHandle;
    pageNumber: number;
    /** CSS width of the page, and the height of its (placeholder) box, both for the turned page. */
    width: number;
    height: number;
    rotation: number;
    textLayer: boolean;
    root: HTMLElement | null;
    onAspect: (pageNumber: number, aspect: number) => void;
    onError: (message: string) => void;
}

/**
 * One page of the document viewer. The box has its final size before anything is
 * drawn, so the scroll height never jumps; the canvas (and text layer) exist only
 * while the box is near the viewport, so a 300-page file holds a handful of bitmaps.
 * Drawing goes to a detached buffer first and is copied over in one call, so a zoom
 * or rotation never shows an empty page.
 */
export default function ViewerPage({ doc, pageNumber, width, height, rotation, textLayer, root, onAspect, onError }: ViewerPageProps) {
    const boxRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textRef = useRef<HTMLDivElement>(null);
    // Without IntersectionObserver (very old engines, tests) every page just renders.
    const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
    const reportAspect = useEffectEvent(onAspect);
    const reportError = useEffectEvent(onError);

    useEffect(() => {
        const box = boxRef.current;
        if (!box || typeof IntersectionObserver === 'undefined') return undefined;
        const io = new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            if (last) setVisible(last.isIntersecting);
        }, { root, rootMargin: ROOT_MARGIN });
        io.observe(box);
        return () => io.disconnect();
    }, [root]);

    useEffect(() => {
        if (!visible || width < 1) return undefined;
        let alive = true;
        let job: RenderJob | null = null;
        let textJob: RenderJob | null = null;
        (async () => {
            try {
                const page: PdfPageHandle = await doc.getPage(pageNumber);
                if (!alive) return;
                reportAspect(pageNumber, page.height / page.width);
                const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
                const buffer = document.createElement('canvas');
                job = page.render(buffer, { cssWidth: width, dpr, rotation });
                if (textLayer && page.renderText && textRef.current) {
                    textJob = page.renderText(textRef.current, { cssWidth: width, rotation });
                    textJob.promise.catch((err: unknown) => { if (!isRenderCancelled(err)) reportError(err instanceof Error ? err.message : 'text'); });
                }
                await job.promise;
                const target = canvasRef.current;
                if (!alive || !target) return;
                target.width = buffer.width;
                target.height = buffer.height;
                target.getContext('2d')?.drawImage(buffer, 0, 0);
            } catch (err) {
                if (alive && !isRenderCancelled(err)) reportError(err instanceof Error ? err.message : 'render');
            }
        })();
        return () => { alive = false; job?.cancel(); textJob?.cancel(); };
    }, [doc, pageNumber, width, rotation, visible, textLayer]);

    const boxStyle: CSSProperties = { width: Math.max(1, width), height: Math.max(1, height) };
    return (
        <div
            ref={boxRef}
            className="relative mx-auto shrink-0 bg-white shadow-sm"
            style={boxStyle}
            data-pdf-viewer-page={pageNumber}
        >
            {visible ? <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" /> : null}
            {visible && textLayer ? <div ref={textRef} className={TEXT_LAYER} data-pdf-text-layer /> : null}
        </div>
    );
}

import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isRenderCancelled } from './pdfEngine';
import type { PdfDocHandle, PdfPageHandle, RenderJob } from './pdfTypes';

/**
 * One PDF page on a high-DPI canvas, with an overlay slot that is exactly the
 * page's box — overlay children use percentages, so they stay aligned at any
 * zoom, scroll position or pane size.
 *
 * Rendering goes to a detached buffer canvas first and is copied over in one
 * draw, so a re-render (zoom, resize) never flashes an empty page. A stale
 * render is cancelled before the next one starts.
 */
export default function PageCanvas({ doc, pageNumber, cssWidth, className, style, children, onPageSize, onError }: {
    doc: PdfDocHandle;
    pageNumber: number;
    cssWidth: number;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
    onPageSize?: (w: number, h: number) => void;
    onError?: (message: string) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    const reportSize = useEffectEvent((w: number, h: number) => onPageSize?.(w, h));
    const reportError = useEffectEvent((m: string) => onError?.(m));

    useEffect(() => {
        if (cssWidth < 1) return undefined;
        let alive = true;
        let job: RenderJob | null = null;
        (async () => {
            try {
                const page: PdfPageHandle = await doc.getPage(pageNumber);
                if (!alive) return;
                const cssHeight = Math.round((cssWidth * page.height) / page.width);
                setSize({ w: cssWidth, h: cssHeight });
                reportSize(page.width, page.height);
                const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
                const buffer = document.createElement('canvas');
                job = page.render(buffer, { cssWidth, dpr });
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
        return () => { alive = false; job?.cancel(); };
    }, [doc, pageNumber, cssWidth]);

    const boxStyle: CSSProperties = { ...style, width: size?.w ?? cssWidth, height: size?.h ?? Math.round(cssWidth * 1.414) };
    return (
        <div className={`relative shrink-0 bg-white shadow-sm ${className || ''}`} style={boxStyle} data-pdf-page={pageNumber}>
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            {children}
        </div>
    );
}

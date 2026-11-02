import { useCallback, useRef, useState, type ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { stepZoom } from '../pdfCompare/pdfCompareMath';
import { usePdfDocument } from '../pdfCompare/hooks';
import type { PdfDocHandle } from '../pdfCompare/pdfTypes';
import { useElementSize, useIsFullscreen, useScrolledPage } from './hooks';
import ViewerPage from './ViewerPage';
import ViewerToolbar from './ViewerToolbar';
import { FALLBACK_ASPECT, nextRotation, pageAtOffset, turnedAspect, viewerPageWidth, type FitMode } from './viewerMath';

const PAD = 12;

export interface PdfViewerProps {
    blob: Blob;
    /** The FILE name — the PDF's own internal title is never shown. */
    name: string;
    /** Object URL of the bytes Download hands over; null when downloads are off. */
    downloadUrl: string | null;
    textLayer: boolean;
    /** Shown (under a message) when pdf.js cannot open the file. */
    fallback: ReactNode;
    boxed: boolean;
}

interface BodyProps extends Omit<PdfViewerProps, 'blob' | 'fallback'> { doc: PdfDocHandle }

function ViewerBody({ doc, name, downloadUrl, textLayer, boxed }: BodyProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const [size, measureRef] = useElementSize();
    const [fit, setFit] = useState<FitMode>('width');
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [page, setPage] = useState(1);
    const [aspects, setAspects] = useState<Record<number, number>>({});
    const fullscreen = useIsFullscreen(rootRef);

    const setScrollerRef = useCallback((el: HTMLDivElement | null) => { setScroller(el); measureRef(el); }, [measureRef]);

    const paneW = Math.max(0, size.w - 2 * PAD);
    const paneH = Math.max(0, size.h - 2 * PAD);
    const aspectOf = (n: number) => turnedAspect(aspects[n] ?? aspects[1] ?? FALLBACK_ASPECT, rotation);
    const width = viewerPageWidth(fit, zoom, paneW, paneH, aspectOf(1));
    const zoomPct = paneW > 0 ? Math.round((width / paneW) * 100) : 100;

    const onAspect = useCallback((n: number, aspect: number) => {
        setAspects((prev) => (prev[n] === aspect ? prev : { ...prev, [n]: aspect }));
    }, []);
    const [renderError, setRenderError] = useState<string | null>(null);
    const { t } = useTranslation();

    const pageTops = useCallback((): number[] => {
        if (!scroller) return [];
        return Array.from(scroller.querySelectorAll<HTMLElement>('[data-pdf-viewer-page]')).map((el) => el.offsetTop);
    }, [scroller]);

    useScrolledPage(scroller, pageTops, setPage);

    const goTo = (n: number) => {
        const target = Math.min(doc.numPages, Math.max(1, n));
        const top = pageTops()[target - 1];
        if (top !== undefined) scroller?.scrollTo?.({ top: Math.max(0, top - PAD) });
        setPage(target);
    };

    const zoomStep = (dir: 1 | -1) => {
        setZoom(stepZoom(paneW > 0 ? width / paneW : zoom, dir));
        setFit('custom');
    };
    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen?.();
        else void rootRef.current?.requestFullscreen?.();
    };

    const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    return (
        <div ref={rootRef} className={`flex w-full min-w-0 flex-col bg-[var(--bg-primary)]${boxed ? ' h-full min-h-0 flex-1' : ' h-[32rem]'}`} data-pdf-viewer>
            <ViewerToolbar
                name={name}
                page={page} numPages={doc.numPages} onPage={goTo}
                fit={fit} zoomPct={zoomPct} onZoomStep={zoomStep}
                onFit={(m) => { setFit(m); setZoom(1); }}
                onRotate={() => setRotation(nextRotation)}
                fullscreen={fullscreen} onFullscreen={toggleFullscreen}
                download={downloadUrl ? { url: downloadUrl, name } : null}
            />
            {renderError ? <div role="alert" className="shrink-0 px-3 py-1 text-xs text-[var(--text-secondary)]">{t('studio_apps_runtime.file_preview.open_failed', 'Could not open this file.')}</div> : null}
            <div ref={setScrollerRef} className="relative min-h-0 flex-1 overflow-auto bg-[var(--bg-tertiary)] p-3" data-pdf-scroller>
                <div className="flex flex-col items-center gap-3">
                    {pages.map((n) => (
                        <ViewerPage
                            key={n}
                            doc={doc}
                            pageNumber={n}
                            width={width}
                            height={Math.round(width * aspectOf(n))}
                            rotation={rotation}
                            textLayer={textLayer}
                            root={scroller}
                            onAspect={onAspect}
                            onError={setRenderError}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

/**
 * file_preview with viewer "app": the PDF drawn by Bee Flow's own pdf.js facade
 * instead of the browser's built-in viewer (dark Chrome bar, the PDF's internal
 * title as heading). A file pdf.js cannot open falls back to `fallback` (the
 * download card) under a plain message, never a blank frame.
 */
export default function PdfViewer({ blob, fallback, ...rest }: PdfViewerProps) {
    const { t } = useTranslation();
    const state = usePdfDocument(blob);
    if (state.status === 'error' || (state.status === 'ready' && !state.doc)) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center">
                <span role="alert" className="px-6 pt-4 text-center text-sm text-[var(--text-secondary)]">{t('studio_apps_runtime.file_preview.open_failed', 'Could not open this file.')}</span>
                {fallback}
            </div>
        );
    }
    if (state.status !== 'ready' || !state.doc) {
        return <div className="flex h-full w-full items-center justify-center p-6 text-xs text-[var(--text-muted)]" role="status">{t('studio_apps_runtime.file_preview.loading_pdf', 'Loading document…')}</div>;
    }
    return <ViewerBody doc={state.doc} {...rest} />;
}

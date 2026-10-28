import { useRef, type CSSProperties, type ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import ChangeBoxes from './ChangeBoxes';
import PageCanvas from './PageCanvas';
import { clampPercent, scrollFromRatio, scrollRatio, type ChangeRegion } from './pdfCompareMath';
import type { PdfDocHandle } from './pdfTypes';
import SwipeSlider from './SwipeSlider';
import type { Mode } from './Toolbar';

/** One scroll container with its label chip. */
function Pane({ label, scrollRef, onScroll, children }: { label: string; scrollRef: (el: HTMLDivElement | null) => void; onScroll: () => void; children: ReactNode }) {
    return (
        <div className="relative min-h-0 min-w-0 flex-1" data-pdf-pane={label}>
            <span className="pointer-events-none absolute left-3 top-2 z-20 max-w-[60%] truncate rounded bg-[var(--bg-primary)]/90 px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] shadow-sm">{label}</span>
            <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-auto bg-[var(--bg-tertiary)] p-2">{children}</div>
        </div>
    );
}

export interface PanesProps {
    mode: Mode;
    left: PdfDocHandle | null; right: PdfDocHandle | null;
    leftLabel: string; rightLabel: string; emptyText: string;
    page: number; cssWidth: number;
    regions: ChangeRegion[]; showBoxes: boolean; activeIndex: number;
    swipe: number; onSwipe: (v: number) => void;
    /** First pane element: measured for fit-to-width and used to jump to a change. */
    firstPaneRef: (el: HTMLDivElement | null) => void;
    onAspect: (ratio: number) => void;
    onError: (message: string) => void;
}

/** Scroll AND zoom stay in step: the second pane follows the first by ratio. */
function useSyncedPanes(firstPaneRef: PanesProps['firstPaneRef']) {
    const first = useRef<HTMLDivElement | null>(null);
    const second = useRef<HTMLDivElement | null>(null);
    const ignore = useRef<HTMLElement | null>(null);
    const sync = (src: HTMLElement | null, dst: HTMLElement | null) => {
        if (!src || !dst) return;
        if (ignore.current === src) { ignore.current = null; return; }
        const top = scrollFromRatio(scrollRatio(src.scrollTop, src.scrollHeight, src.clientHeight), dst.scrollHeight, dst.clientHeight);
        const left = scrollFromRatio(scrollRatio(src.scrollLeft, src.scrollWidth, src.clientWidth), dst.scrollWidth, dst.clientWidth);
        // Only arm the guard when the write will really fire a scroll event.
        if (top === dst.scrollTop && left === dst.scrollLeft) return;
        ignore.current = dst;
        dst.scrollTop = top;
        dst.scrollLeft = left;
    };
    return {
        setFirst: (el: HTMLDivElement | null) => { first.current = el; firstPaneRef(el); },
        setSecond: (el: HTMLDivElement | null) => { second.current = el; },
        fromFirst: () => sync(first.current, second.current),
        fromSecond: () => sync(second.current, first.current),
    };
}

export default function ComparePanes(p: PanesProps) {
    const { t } = useTranslation();
    const panes = useSyncedPanes(p.firstPaneRef);
    const pageOf = (doc: PdfDocHandle | null) => {
        if (!doc) return <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">{p.emptyText}</div>;
        if (p.page > doc.numPages) {
            return <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">{t('studio_apps_runtime.pdf_compare.no_such_page', 'This document has no page {n}.', { n: p.page })}</div>;
        }
        return (
            <PageCanvas doc={doc} pageNumber={p.page} cssWidth={p.cssWidth} className="mx-auto" onPageSize={(w, h) => p.onAspect(h / w)} onError={p.onError}>
                {p.showBoxes ? <ChangeBoxes regions={p.regions} activeIndex={p.activeIndex} /> : null}
            </PageCanvas>
        );
    };

    if (p.mode === 'swipe' && p.left && p.right) {
        const clip: CSSProperties = { clipPath: `inset(0 0 0 ${clampPercent(p.swipe)}%)` };
        return (
            <div className="flex min-h-0 min-w-0 flex-1">
                <Pane label={`${p.leftLabel} | ${p.rightLabel}`} scrollRef={panes.setFirst} onScroll={() => undefined}>
                    <div className="relative mx-auto w-fit">
                        <PageCanvas doc={p.left} pageNumber={p.page} cssWidth={p.cssWidth} onPageSize={(w, h) => p.onAspect(h / w)} onError={p.onError} />
                        <div className="absolute inset-0" style={clip}>
                            {p.page <= p.right.numPages ? <PageCanvas doc={p.right} pageNumber={p.page} cssWidth={p.cssWidth} /> : null}
                        </div>
                        {p.showBoxes ? <ChangeBoxes regions={p.regions} activeIndex={p.activeIndex} /> : null}
                        <SwipeSlider value={p.swipe} onChange={p.onSwipe} label={t('studio_apps_runtime.pdf_compare.slider', 'Compare slider')} />
                    </div>
                </Pane>
            </div>
        );
    }
    if (p.mode === 'diff' && p.left && p.right) {
        return (
            <div className="flex min-h-0 min-w-0 flex-1">
                <Pane label={p.rightLabel} scrollRef={panes.setFirst} onScroll={() => undefined}>{pageOf(p.right)}</Pane>
            </div>
        );
    }
    return (
        <div className="flex min-h-0 min-w-0 flex-1 gap-px bg-[var(--border-default)]">
            <Pane label={p.leftLabel} scrollRef={panes.setFirst} onScroll={panes.fromFirst}>{pageOf(p.left)}</Pane>
            <Pane label={p.rightLabel} scrollRef={panes.setSecond} onScroll={panes.fromSecond}>{pageOf(p.right)}</Pane>
        </div>
    );
}

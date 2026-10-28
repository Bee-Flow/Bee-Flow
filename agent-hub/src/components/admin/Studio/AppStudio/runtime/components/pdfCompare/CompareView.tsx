import { useEffect, useRef, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import ComparePanes from './ComparePanes';
import { useChanges, useElementWidth } from './hooks';
import { clampPage, nextChange, pageCssWidth } from './pdfCompareMath';
import type { PdfDocHandle } from './pdfTypes';
import ThumbStrip from './ThumbStrip';
import Toolbar, { type DownloadLink, type Mode } from './Toolbar';

const PAD = 16; // p-2 each side of a pane

export interface CompareViewProps {
    left: PdfDocHandle | null; right: PdfDocHandle | null;
    leftLabel: string; rightLabel: string; emptyText: string;
    initialMode: Mode;
    downloads: DownloadLink[] | null;
    onError: (message: string) => void;
}

function changesLabel(t: ReturnType<typeof useTranslation>['t'], known: boolean, mismatch: boolean, count: number): string {
    if (mismatch) return t('studio_apps_runtime.pdf_compare.size_mismatch', 'Page sizes differ');
    if (!known) return t('studio_apps_runtime.pdf_compare.comparing', 'Comparing…');
    if (count === 0) return t('studio_apps_runtime.pdf_compare.no_changes', 'No changes on this page');
    if (count === 1) return t('studio_apps_runtime.pdf_compare.one_change', '1 change on this page');
    return t('studio_apps_runtime.pdf_compare.n_changes', '{count} changes on this page', { count });
}

/** Everything after the documents are open: view state, change detection, toolbar, panes. */
export default function CompareView(props: CompareViewProps) {
    const { left, right } = props;
    const { t } = useTranslation();
    const comparable = !!left && !!right;
    const numPages = Math.max(left?.numPages || 0, right?.numPages || 0);

    const [mode, setMode] = useState<Mode>(props.initialMode);
    useEffect(() => { setMode(props.initialMode); }, [props.initialMode]);
    const [page, setPage] = useState(1);
    const [zoom, setZoom] = useState(1);
    const [showChanges, setShowChanges] = useState(true);
    const [thumbs, setThumbs] = useState(false);
    const [swipe, setSwipe] = useState(50);
    const [active, setActive] = useState<{ page: number; index: number } | null>(null);
    const [jump, setJump] = useState(0);

    const { byPage, mismatch } = useChanges(left, right, comparable, page);
    const [measured, measureRef] = useElementWidth();
    const paneEl = useRef<HTMLDivElement | null>(null);
    const aspect = useRef(1.414);
    const cssWidth = measured > PAD ? pageCssWidth(measured - PAD, zoom) : 0;
    const regions = (comparable && byPage[page]) || [];
    const activeIndex = active && active.page === page ? active.index : -1;
    const anyChanges = Object.values(byPage).some((r) => r.length > 0);

    const goChange = (dir: 1 | -1) => {
        const next = nextChange(byPage, numPages, page, activeIndex, dir);
        if (!next) return;
        setShowChanges(true);
        setPage(next.page);
        setActive(next);
        setJump((j) => j + 1);
    };
    // Scroll the target box to the middle of the pane, once per request.
    useEffect(() => {
        const r = jump && active ? byPage[active.page]?.[active.index] : null;
        const el = paneEl.current;
        if (!r || !el || !cssWidth) return;
        const top = 8 + (r.y + r.h / 2) * cssWidth * aspect.current - el.clientHeight / 2;
        el.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per jump request only
    }, [jump]);

    const safePage = clampPage(page, numPages);
    const changesText = comparable ? changesLabel(t, byPage[page] !== undefined, !!mismatch[page], regions.length) : '';
    const thumbDoc = (right || left) as PdfDocHandle;
    return (
        <>
            <Toolbar
                page={safePage} numPages={numPages} onPage={setPage} zoom={zoom} onZoom={setZoom}
                mode={mode} onMode={setMode} comparable={comparable}
                showChanges={showChanges} onShowChanges={setShowChanges} thumbs={thumbs} onThumbs={setThumbs}
                anyChanges={anyChanges} onChange={goChange} changesText={changesText} changeCount={regions.length}
                downloads={props.downloads}
            />
            <div className="flex min-h-0 flex-1">
                {thumbs ? <ThumbStrip doc={thumbDoc} numPages={thumbDoc.numPages} page={safePage} byPage={comparable ? byPage : {}} onSelect={(n) => { setPage(n); setActive(null); }} /> : null}
                <ComparePanes
                    mode={mode} left={left} right={right} leftLabel={props.leftLabel} rightLabel={props.rightLabel} emptyText={props.emptyText}
                    page={safePage} cssWidth={cssWidth} regions={regions} showBoxes={comparable && (mode === 'diff' || showChanges)} activeIndex={activeIndex}
                    swipe={swipe} onSwipe={setSwipe}
                    firstPaneRef={(el) => { paneEl.current = el; measureRef(el); }}
                    onAspect={(r) => { aspect.current = r; }} onError={props.onError}
                />
            </div>
        </>
    );
}

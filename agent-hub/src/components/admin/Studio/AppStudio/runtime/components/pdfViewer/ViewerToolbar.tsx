import { ChevronLeft, ChevronRight, Download, Expand, Maximize2, Minimize2, RotateCw, ScanLine, ZoomIn, ZoomOut } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { hoverable } from '../../hoverable';
import { MAX_ZOOM, MIN_ZOOM } from '../pdfCompare/pdfCompareMath';
import { Sep, ToolButton } from '../pdfCompare/Toolbar';
import type { FitMode } from './viewerMath';

const ICON = 'h-4 w-4';
const K = 'studio_apps_runtime.file_preview.';

export interface ViewerToolbarProps {
    name: string;
    page: number; numPages: number; onPage: (p: number) => void;
    fit: FitMode; zoomPct: number; onZoomStep: (dir: 1 | -1) => void; onFit: (m: 'width' | 'page') => void;
    onRotate: () => void;
    fullscreen: boolean; onFullscreen: () => void;
    download: { url: string; name: string } | null;
}

/** The viewer's own bar: themed with the app's variables, never the browser's dark one. */
export default function ViewerToolbar(p: ViewerToolbarProps) {
    const { t } = useTranslation();
    return (
        <div role="toolbar" aria-label={t(`${K}viewer_toolbar`, 'PDF viewer')} className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1">
            <span className="mr-2 min-w-0 flex-1 basis-24 truncate text-xs font-medium text-[var(--text-primary)]" {...hoverable(p.name)}>{p.name}</span>
            <ToolButton label={t(`${K}prev_page`, 'Previous page')} disabled={p.page <= 1} onClick={() => p.onPage(p.page - 1)}><ChevronLeft className={ICON} aria-hidden="true" /></ToolButton>
            <span className="min-w-[3.25rem] shrink-0 text-center text-xs tabular-nums text-[var(--text-secondary)]" aria-live="polite">
                {t(`${K}page_of`, '{page} / {total}', { page: p.page, total: p.numPages })}
            </span>
            <ToolButton label={t(`${K}next_page`, 'Next page')} disabled={p.page >= p.numPages} onClick={() => p.onPage(p.page + 1)}><ChevronRight className={ICON} aria-hidden="true" /></ToolButton>
            <Sep />
            <ToolButton label={t(`${K}zoom_out`, 'Zoom out')} disabled={p.zoomPct <= MIN_ZOOM * 100} onClick={() => p.onZoomStep(-1)}><ZoomOut className={ICON} aria-hidden="true" /></ToolButton>
            <span className="min-w-[2.5rem] shrink-0 text-center text-xs tabular-nums text-[var(--text-secondary)]" data-pdf-zoom>{p.zoomPct}%</span>
            <ToolButton label={t(`${K}zoom_in`, 'Zoom in')} disabled={p.zoomPct >= MAX_ZOOM * 100} onClick={() => p.onZoomStep(1)}><ZoomIn className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t(`${K}fit_width`, 'Fit width')} pressed={p.fit === 'width'} onClick={() => p.onFit('width')}><Maximize2 className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t(`${K}fit_page`, 'Fit page')} pressed={p.fit === 'page'} onClick={() => p.onFit('page')}><ScanLine className={ICON} aria-hidden="true" /></ToolButton>
            <Sep />
            <ToolButton label={t(`${K}rotate`, 'Rotate')} onClick={p.onRotate}><RotateCw className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={p.fullscreen ? t(`${K}exit_fullscreen`, 'Exit fullscreen') : t(`${K}fullscreen`, 'Fullscreen')} pressed={p.fullscreen} onClick={p.onFullscreen}>
                {p.fullscreen ? <Minimize2 className={ICON} aria-hidden="true" /> : <Expand className={ICON} aria-hidden="true" />}
            </ToolButton>
            {p.download ? (
                <a
                    href={p.download.url}
                    download={p.download.name}
                    aria-label={t(`${K}download_name`, 'Download {name}', { name: p.download.name })}
                    className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded px-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                    <Download className={ICON} aria-hidden="true" />
                </a>
            ) : null}
        </div>
    );
}

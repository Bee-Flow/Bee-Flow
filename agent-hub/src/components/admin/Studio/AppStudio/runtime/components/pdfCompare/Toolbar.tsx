import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Columns2, Diff, Download, Eye, Maximize2, PanelLeft, SlidersHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { clampPage, MAX_ZOOM, MIN_ZOOM, stepZoom } from './pdfCompareMath';

export type Mode = 'side' | 'swipe' | 'diff';

const BTN = 'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded px-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-[var(--bg-tertiary)] aria-pressed:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--app-accent,#2563eb)]';
const ICON = 'h-4 w-4';

function ToolButton({ label, onClick, pressed, disabled, children }: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: ReactNode }) {
    return (
        <button type="button" className={BTN} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
            {children}
        </button>
    );
}
const Sep = () => <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border-default)]" aria-hidden="true" />;

export interface DownloadLink { url: string | null; name: string; label: string }

export interface ToolbarProps {
    page: number; numPages: number; onPage: (p: number) => void;
    zoom: number; onZoom: (z: number) => void;
    mode: Mode; onMode: (m: Mode) => void;
    comparable: boolean;
    showChanges: boolean; onShowChanges: (v: boolean) => void;
    thumbs: boolean; onThumbs: (v: boolean) => void;
    anyChanges: boolean; onChange: (dir: 1 | -1) => void;
    changesText: string; changeCount: number;
    downloads: DownloadLink[] | null;
}

function PageNav({ page, numPages, onPage }: Pick<ToolbarProps, 'page' | 'numPages' | 'onPage'>) {
    const { t } = useTranslation();
    return (
        <>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.prev_page', 'Previous page')} disabled={page <= 1} onClick={() => onPage(clampPage(page - 1, numPages))}><ChevronLeft className={ICON} aria-hidden="true" /></ToolButton>
            <span className="min-w-[3.25rem] shrink-0 text-center text-xs tabular-nums text-[var(--text-secondary)]" aria-live="polite">
                {t('studio_apps_runtime.pdf_compare.page_of', '{page} / {total}', { page, total: numPages })}
            </span>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.next_page', 'Next page')} disabled={page >= numPages} onClick={() => onPage(clampPage(page + 1, numPages))}><ChevronRight className={ICON} aria-hidden="true" /></ToolButton>
        </>
    );
}

function ZoomControls({ zoom, onZoom }: Pick<ToolbarProps, 'zoom' | 'onZoom'>) {
    const { t } = useTranslation();
    return (
        <>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.zoom_out', 'Zoom out')} disabled={zoom <= MIN_ZOOM} onClick={() => onZoom(stepZoom(zoom, -1))}><ZoomOut className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.fit_width', 'Fit width')} pressed={zoom === 1} onClick={() => onZoom(1)}>
                <Maximize2 className={ICON} aria-hidden="true" />
                {zoom !== 1 ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
            </ToolButton>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.zoom_in', 'Zoom in')} disabled={zoom >= MAX_ZOOM} onClick={() => onZoom(stepZoom(zoom, 1))}><ZoomIn className={ICON} aria-hidden="true" /></ToolButton>
        </>
    );
}

function ChangeControls(p: ToolbarProps) {
    const { t } = useTranslation();
    const modes: Array<{ id: Mode; label: string; icon: ReactNode }> = [
        { id: 'side', label: t('studio_apps_runtime.pdf_compare.mode_side', 'Side by side'), icon: <Columns2 className={ICON} aria-hidden="true" /> },
        { id: 'swipe', label: t('studio_apps_runtime.pdf_compare.mode_swipe', 'Swipe'), icon: <SlidersHorizontal className={ICON} aria-hidden="true" /> },
        { id: 'diff', label: t('studio_apps_runtime.pdf_compare.mode_diff', 'Differences'), icon: <Diff className={ICON} aria-hidden="true" /> },
    ];
    return (
        <>
            <Sep />
            {modes.map((m) => <ToolButton key={m.id} label={m.label} pressed={p.mode === m.id} onClick={() => p.onMode(m.id)}>{m.icon}</ToolButton>)}
            <Sep />
            <ToolButton label={t('studio_apps_runtime.pdf_compare.show_changes', 'Show changes')} pressed={p.mode === 'diff' || p.showChanges} disabled={p.mode === 'diff'} onClick={() => p.onShowChanges(!p.showChanges)}>
                <Eye className={ICON} aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.prev_change', 'Previous change')} disabled={!p.anyChanges} onClick={() => p.onChange(-1)}><ChevronUp className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.next_change', 'Next change')} disabled={!p.anyChanges} onClick={() => p.onChange(1)}><ChevronDown className={ICON} aria-hidden="true" /></ToolButton>
            <span className={`shrink-0 whitespace-nowrap px-1 text-xs ${p.changeCount > 0 ? 'font-medium text-red-600' : 'text-[var(--text-muted)]'}`} data-pdf-change-count={p.changeCount} aria-live="polite">{p.changesText}</span>
        </>
    );
}

/** One compact row (h-10): icon buttons with tooltips and aria-labels. */
export default function Toolbar(p: ToolbarProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border-default)] px-1.5" role="toolbar" aria-label={t('studio_apps_runtime.pdf_compare.toolbar', 'Document comparison')}>
            <ToolButton label={t('studio_apps_runtime.pdf_compare.thumbs_toggle', 'Page overview')} pressed={p.thumbs} onClick={() => p.onThumbs(!p.thumbs)}><PanelLeft className={ICON} aria-hidden="true" /></ToolButton>
            <PageNav page={p.page} numPages={p.numPages} onPage={p.onPage} />
            <Sep />
            <ZoomControls zoom={p.zoom} onZoom={p.onZoom} />
            {p.comparable ? <ChangeControls {...p} /> : null}
            {p.downloads ? (
                <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
                    {p.downloads.filter((d) => d.url).map((d) => {
                        const label = t('studio_apps_runtime.pdf_compare.download', 'Download {name}', { name: d.label });
                        return (
                            <a key={d.label} href={d.url as string} download={d.name} className={BTN} title={label} aria-label={label}>
                                <Download className={ICON} aria-hidden="true" />
                                <span className="max-w-[6rem] truncate">{d.label}</span>
                            </a>
                        );
                    })}
                </span>
            ) : null}
        </div>
    );
}

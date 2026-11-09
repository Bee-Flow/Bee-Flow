import { Flame, MousePointerClick, MoveVertical, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Empty, fmt, pillClass } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { PageRailProps, FigureProps } from './HeatmapSection.types';
import { EYEBROW, SECONDARY_BTN } from '@/components/mcpLibrary/ui';

const MODES = [
    { id: 'click', labelKey: 'cms_site.analytics.heatmap.mode_click', label: 'Clicks', icon: MousePointerClick },
    { id: 'scroll', labelKey: 'cms_site.analytics.heatmap.mode_scroll', label: 'Scroll depth', icon: MoveVertical },
];

export function PageRail({
    index, pages, urlPath, onSelectPath, mode, onSelectMode,
    widthGroups, activeWidth, onSelectWidth, clicks, sessions, views,
}: PageRailProps) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.heatmap.title', 'Heatmap')} icon={Flame} action={
            <div className="flex gap-1.5">
                {MODES.map(m => (
                    <button key={m.id} onClick={() => onSelectMode(m.id)} aria-pressed={mode === m.id} className={pillClass(mode === m.id)}>
                        <m.icon className="w-[12px] h-[12px]" /> {t(m.labelKey, m.label)}
                    </button>
                ))}
            </div>
        }>
            {index.error ? <ErrorNote message={index.error} onRetry={index.reload} compact />
                : index.loading ? <Skeleton height={54} />
                : pages.length === 0 ? (
                    <Empty text={t('cms_site.analytics.heatmap.no_clicks', 'No clicks recorded yet. Recording starts once a visitor accepts your cookie banner.')} />
                ) : (
                    <div className="flex gap-3.5 flex-wrap items-end">
                        <label className="flex flex-col gap-1">
                            <span className={EYEBROW}>{t('cms_site.analytics.heatmap.page', 'Page')}</span>
                            <select value={urlPath} onChange={(e) => onSelectPath(e.target.value)} className="h-8 min-w-[240px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]">
                                {pages.map(p => (
                                    <option key={p.urlPath} value={p.urlPath}>
                                        {t('cms_site.analytics.heatmap.page_option', '{path} — {n} clicks', { path: p.urlPath, n: fmt(p.count) })}
                                    </option>
                                ))}
                            </select>
                        </label>

                        {widthGroups.length > 1 && (
                            <div className="flex flex-col gap-1">
                                <span className={EYEBROW}>{t('cms_site.analytics.heatmap.captured_at', 'Captured at')}</span>
                                <div className="flex gap-1.5">
                                    {widthGroups.map(g => (
                                        <button key={g.width} onClick={() => onSelectWidth(g.width)}
                                            title={t('cms_site.analytics.heatmap.width_title', '{clicks} clicks at {width}px wide', { clicks: fmt(g.clicks), width: g.width })}
                                            aria-pressed={activeWidth === g.width} className={pillClass(activeWidth === g.width)}>
                                            {g.width}px · {Math.round(g.share)}%
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="flex gap-4.5 ml-auto">
                            <Figure label={t('cms_site.analytics.heatmap.fig_clicks', 'Clicks')} value={fmt(clicks)} />
                            <Figure label={t('cms_site.analytics.heatmap.fig_sessions', 'Sessions')} value={fmt(sessions)} />
                            {views > 0 && <Figure label={t('cms_site.analytics.heatmap.fig_views', 'Views')} value={fmt(views)} />}
                        </div>

                        <a href={urlPath} target="_blank" rel="noreferrer" className={SECONDARY_BTN}>
                            {t('cms_site.analytics.heatmap.open_live', 'Open live page')} <ExternalLink className="w-[11px] h-[11px]" />
                        </a>
                    </div>
                )}
        </Card>
    );
}

function Figure({ label, value }: FigureProps) {
    return (
        <div>
            <div className={EYEBROW}>{label}</div>
            <div className="text-base font-semibold text-[var(--text-primary)]">{value}</div>
        </div>
    );
}


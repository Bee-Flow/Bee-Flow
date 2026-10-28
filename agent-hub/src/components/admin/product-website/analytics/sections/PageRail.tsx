import { Flame, MousePointerClick, MoveVertical, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Empty, fmt } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { PageRailProps, FigureProps } from './HeatmapSection.types';

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
            <div className="[display:flex] [gap:6px]">
                {MODES.map(m => (
                    <button key={m.id} onClick={() => onSelectMode(m.id)} style={chipStyle(mode === m.id)}>
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
                    <div className="[display:flex] [gap:14px] [flex-wrap:wrap] [align-items:flex-end]">
                        <label className="[display:flex] [flex-direction:column] [gap:4px]">
                            <span style={labelStyle}>{t('cms_site.analytics.heatmap.page', 'Page')}</span>
                            <select value={urlPath} onChange={(e) => onSelectPath(e.target.value)} style={selectStyle}>
                                {pages.map(p => (
                                    <option key={p.urlPath} value={p.urlPath}>
                                        {t('cms_site.analytics.heatmap.page_option', '{path} — {n} clicks', { path: p.urlPath, n: fmt(p.count) })}
                                    </option>
                                ))}
                            </select>
                        </label>

                        {widthGroups.length > 1 && (
                            <div className="[display:flex] [flex-direction:column] [gap:4px]">
                                <span style={labelStyle}>{t('cms_site.analytics.heatmap.captured_at', 'Captured at')}</span>
                                <div className="[display:flex] [gap:6px]">
                                    {widthGroups.map(g => (
                                        <button key={g.width} onClick={() => onSelectWidth(g.width)}
                                            title={t('cms_site.analytics.heatmap.width_title', '{clicks} clicks at {width}px wide', { clicks: fmt(g.clicks), width: g.width })}
                                            style={chipStyle(activeWidth === g.width)}>
                                            {g.width}px · {Math.round(g.share)}%
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="[display:flex] [gap:18px] [margin-left:auto]">
                            <Figure label={t('cms_site.analytics.heatmap.fig_clicks', 'Clicks')} value={fmt(clicks)} />
                            <Figure label={t('cms_site.analytics.heatmap.fig_sessions', 'Sessions')} value={fmt(sessions)} />
                            {views > 0 && <Figure label={t('cms_site.analytics.heatmap.fig_views', 'Views')} value={fmt(views)} />}
                        </div>

                        <a href={urlPath} target="_blank" rel="noreferrer" style={linkStyle}>
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
            <div style={labelStyle}>{label}</div>
            <div className="[font-size:16px] [font-weight:800] [color:var(--text-primary,#fff)]">{value}</div>
        </div>
    );
}

const labelStyle = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: 'var(--text-muted, #888)',
};

const selectStyle = {
    background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
    borderRadius: 8, padding: '7px 10px', fontSize: 12, minWidth: 240,
};

const linkStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
    color: ACCENT, textDecoration: 'none', border: `1px solid ${ACCENT}44`,
    borderRadius: 7, padding: '5px 10px',
};

const chipStyle = (active: boolean) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
    borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 700,
    border: `1px solid ${active ? `${ACCENT}66` : 'var(--border-subtle, rgba(255,255,255,0.1))'}`,
    background: active ? `${ACCENT}14` : 'transparent',
    color: active ? ACCENT : 'var(--text-muted, #888)',
});

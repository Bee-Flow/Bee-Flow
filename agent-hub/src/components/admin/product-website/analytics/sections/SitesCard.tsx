import { Loader2, ShieldAlert, Video } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { analyticsApi, analyticsFetch, type AnalyticsSite } from '../../analyticsApi';
import { rich } from '../rich';
import { Card, ErrorNote } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { RecorderResponse, SitesCardProps } from './SettingsSection.types';

export function SitesCard({ sites, onChanged }: SitesCardProps) {
    const { t } = useTranslation();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const toggleRecording = async (site: AnalyticsSite, next: boolean) => {
        setBusyId(site.id); setError(null);
        try {
            const res = await analyticsFetch(analyticsApi.recorder(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ siteId: site.id, enabled: next }),
            }) as RecorderResponse | null;
            if (res?.upstreamWarning) {
                setError(t('cms_site.analytics.settings.recorder_warning', 'Saved, but Umami did not accept the recorder flag: {warning}', { warning: res.upstreamWarning }));
            }
            onChanged?.();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusyId(null);
        }
    };

    const tracked = sites.filter(s => s.tracked);

    return (
        <Card title={t('cms_site.analytics.settings.sites', 'Sites')}>
            {error && <div className="[margin-bottom:10px]"><ErrorNote message={error} compact /></div>}
            {tracked.length === 0 ? (
                <p className="[font-size:12px] [color:var(--text-muted,#888)] [margin:0]">
                    {t('cms_site.analytics.settings.no_sites', 'No site is tracked yet. Publish a CMS site while tracking is enabled and it will appear here.')}
                </p>
            ) : (
                <div className="[display:flex] [flex-direction:column] [gap:10px]">
                    {tracked.map(site => (
                        <div key={site.id} className="[display:flex] [align-items:center] [justify-content:space-between] [gap:12px] [padding:10px_12px] [border-radius:10px] [background:var(--bg-tertiary,rgba(255,255,255,0.03))]">
                            <div className="min-w-[0]">
                                <div className="[font-size:13px] [font-weight:700] [color:var(--text-primary,#fff)]">
                                    {site.name}{site.live ? <span style={{ color: ACCENT, fontWeight: 600 }}> · {t('cms_site.analytics.settings.live', 'live')}</span> : null}
                                </div>
                                <div className="[font-size:11px] [color:var(--text-muted,#777)] [font-family:ui-monospace,monospace]">
                                    {site.websiteId || '—'}
                                </div>
                            </div>
                            <button
                                onClick={() => toggleRecording(site, !site.recording)}
                                disabled={busyId === site.id}
                                aria-pressed={!!site.recording}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                                    padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                                    background: site.recording ? `${ACCENT}18` : 'transparent',
                                    border: `1px solid ${site.recording ? `${ACCENT}66` : 'var(--border-default, rgba(255,255,255,0.12))'}`,
                                    color: site.recording ? ACCENT : 'var(--text-secondary, #aaa)',
                                }}
                            >
                                {busyId === site.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-[13px] h-[13px]" />}
                                {site.recording ? t('cms_site.analytics.settings.recording_on', 'Recording on') : t('cms_site.analytics.settings.record_sessions', 'Record sessions')}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="[display:flex] [gap:8px] [margin-top:12px] [align-items:flex-start] [font-size:11px] [color:var(--text-muted,#888)]">
                <ShieldAlert className="w-[14px] h-[14px] [margin-top:1px] [flex-shrink:0] [color:#f59e0b]" />
                <span>
                    {rich(t('cms_site.analytics.settings.recording_note', 'Session recording powers heatmaps and replays. It loads a larger script that captures clicks, scrolling and page structure, so it only ever runs for visitors who accepted your cookie banner — {modes}. Form inputs are masked. If your cookie banner is disabled, recording can never start.'), {
                        modes: <strong>{t('cms_site.analytics.settings.recording_modes', 'in every consent mode, including cookieless')}</strong>,
                    })}
                </span>
            </div>
        </Card>
    );
}

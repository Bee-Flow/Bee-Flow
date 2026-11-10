import { Loader2, ShieldAlert, Video } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { analyticsApi, analyticsFetch, type AnalyticsSite } from '../../analyticsApi';
import { rich } from '../rich';
import { Card, ErrorNote } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { RecorderResponse, SitesCardProps } from './SettingsSection.types';
import { pillClass } from '../ui';

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
            {error && <div className="mb-2.5"><ErrorNote message={error} compact /></div>}
            {tracked.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)] m-0">
                    {t('cms_site.analytics.settings.no_sites', 'No site is tracked yet. Publish a CMS site while tracking is enabled and it will appear here.')}
                </p>
            ) : (
                <div className="flex flex-col gap-2.5">
                    {tracked.map(site => (
                        <div key={site.id} className="flex items-center justify-between gap-3 py-2.5 px-3 rounded-lg bg-[var(--bg-tertiary)]">
                            <div className="min-w-[0]">
                                <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                                    {site.name}{site.live ? <span className="font-semibold text-[var(--success-ink)]"> · {t('cms_site.analytics.settings.live', 'live')}</span> : null}
                                </div>
                                <div className="text-[11px] text-[var(--text-tertiary)] font-mono">
                                    {site.websiteId || '—'}
                                </div>
                            </div>
                            <button
                                onClick={() => toggleRecording(site, !site.recording)}
                                disabled={busyId === site.id}
                                aria-pressed={!!site.recording}
                                type="button" className={pillClass(!!site.recording)}
                            >
                                {busyId === site.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-[13px] h-[13px]" />}
                                {site.recording ? t('cms_site.analytics.settings.recording_on', 'Recording on') : t('cms_site.analytics.settings.record_sessions', 'Record sessions')}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex gap-2 mt-3 items-start text-[11px] text-[var(--text-tertiary)]">
                <ShieldAlert className="w-[14px] h-[14px] mt-[1px] shrink-0 text-[var(--warning-ink)]" />
                <span>
                    {rich(t('cms_site.analytics.settings.recording_note', 'Session recording powers heatmaps and replays. It loads a larger script that captures clicks, scrolling and page structure, so it only ever runs for visitors who accepted your cookie banner — {modes}. Form inputs are masked. If your cookie banner is disabled, recording can never start.'), {
                        modes: <strong>{t('cms_site.analytics.settings.recording_modes', 'in every consent mode, including cookieless')}</strong>,
                    })}
                </span>
            </div>
        </Card>
    );
}

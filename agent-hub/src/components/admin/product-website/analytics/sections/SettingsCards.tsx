import { Loader2, ShieldAlert, Video, CheckCircle2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { analyticsApi, analyticsFetch } from '../../analyticsApi';
import { rich } from '../rich';
import { ACCENT, Card, ErrorNote } from '../ui';
import type { TrackerSettings, RecorderSettings, SiteEntry, RecorderResponse, DiagnoseCheck, DiagnoseResponse, StatusResponse } from './SettingsSection.types';

/**
 * Tracker options mirrored onto the public <script> tag.
 *
 * Notably absent: a switch for web vitals. They are cookieless browser timings
 * riding along with a pageview already being sent under the same consent
 * decision — and making them optional is exactly how they ended up switched off
 * and unnoticed for the entire life of the feature.
 */
export function TrackerCard({ tracker, onChange }: {
    tracker: TrackerSettings;
    onChange: (k: keyof TrackerSettings, v: string | boolean) => void;
    onSave?: () => void;
    saving?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.settings.tracker_title', 'What the tracker records')}>
            <Field label={t('cms_site.analytics.settings.env_tag', 'Environment tag')} hint={t('cms_site.analytics.settings.env_tag_hint', 'Optional label attached to every event, so you can tell staging from production in the same Umami instance.')}>
                <input value={tracker.tag || ''} onChange={(e) => onChange('tag', e.target.value)}
                    placeholder={t('cms_site.analytics.settings.env_tag_ph', 'production')} style={inputStyle} />
            </Field>
            <Field label={t('cms_site.analytics.settings.domains', 'Only track these domains')} hint={t('cms_site.analytics.settings.domains_hint', 'Comma-separated hostnames. Leave blank to track wherever the site is served. Useful to stop a staging copy polluting your numbers.')}>
                <input value={tracker.domains || ''} onChange={(e) => onChange('domains', e.target.value)}
                    placeholder={t('cms_site.analytics.settings.domains_ph', 'www.example.com, example.com')} style={inputStyle} />
            </Field>
            <Toggle label={t('cms_site.analytics.settings.hash', 'Drop #anchors from URLs')}
                hint={t('cms_site.analytics.settings.hash_hint', 'On by default — otherwise /pricing#plans and /pricing count as two different pages.')}
                checked={tracker.excludeHash !== false} onChange={(v) => onChange('excludeHash', v)} />
            <Toggle label={t('cms_site.analytics.settings.search', 'Drop ?query strings from URLs')}
                hint={t('cms_site.analytics.settings.search_hint', 'Stronger privacy and tidier reports, but you lose UTM campaign attribution. Off by default for that reason.')}
                checked={!!tracker.excludeSearch} onChange={(v) => onChange('excludeSearch', v)} />
            <Toggle label={t('cms_site.analytics.settings.dnt', 'Honour Do Not Track')}
                hint={t('cms_site.analytics.settings.dnt_hint', 'Skip visitors whose browser sends a DNT header. They then appear nowhere in your numbers.')}
                checked={!!tracker.doNotTrack} onChange={(v) => onChange('doNotTrack', v)} />
            <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: '2px 0 0' }}>
                {t('cms_site.analytics.settings.tracker_note', "Saved with the button above. Changes apply on a visitor's next page load — no republish needed. Core Web Vitals are always collected: they are browser timings only, carried by the same request as the pageview.")}
            </p>
        </Card>
    );
}

/** Sampling and masking for the session recorder. */
export function RecorderCard({ recorder, maskLevels = ['strict', 'moderate'], onChange }: {
    recorder: RecorderSettings;
    maskLevels?: string[];
    onChange: (k: keyof RecorderSettings, v: string | number) => void;
}) {
    const { t } = useTranslation();
    const rate = Number(recorder.sampleRate ?? 1);
    return (
        <Card title={t('cms_site.analytics.settings.recorder_title', 'Session recording quality')}>
            <Field label={t('cms_site.analytics.settings.sample_label', 'Record {pct}% of consenting sessions', { pct: Math.round(rate * 100) })}
                hint={t('cms_site.analytics.settings.sample_hint', "Umami's own default is 15%, which on a marketing site means most real visits are never recorded and the heatmap looks broken. 100% is the right answer until you have real volume.")}>
                <input type="range" min="0.05" max="1" step="0.05" value={rate}
                    onChange={(e) => onChange('sampleRate', Number(e.target.value))}
                    style={{ width: '100%', marginTop: 6, accentColor: ACCENT }} />
            </Field>
            <div style={{ marginBottom: 6 }}>
                <label style={labelStyle}>{t('cms_site.analytics.settings.masking', 'Input masking')}</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    {maskLevels.map(l => (
                        <ModeChip key={l} active={(recorder.maskLevel || 'strict') === l}
                            onClick={() => onChange('maskLevel', l)}
                            title={l === 'strict' ? t('cms_site.analytics.settings.mask_strict', 'Strict') : t('cms_site.analytics.settings.mask_moderate', 'Moderate')}
                            desc={l === 'strict' ? t('cms_site.analytics.settings.mask_strict_desc', 'Mask all text input')
                                : t('cms_site.analytics.settings.mask_moderate_desc', 'Mask passwords and marked fields')} />
                    ))}
                </div>
                {recorder.maskLevel === 'moderate' && (
                    <p style={{ fontSize: 11, color: '#fcd34d', margin: '6px 0 0' }}>
                        {t('cms_site.analytics.settings.mask_warning', 'Moderate masking records what visitors type into unmarked fields, which can include personal data. Strict is the safer default for a privacy-first product.')}
                    </p>
                )}
            </div>
        </Card>
    );
}

/**
 * End-to-end diagnostic.
 *
 * Every failure mode on this integration presents identically — an empty
 * dashboard — so this walks the chain in causal order and names the first thing
 * that is actually broken.
 */
export function DiagnoseCard() {
    const { t } = useTranslation();
    const [state, setState] = useState<{ checks: DiagnoseCheck[] | null; loading: boolean; error: string | null }>({ checks: null, loading: false, error: null });

    const run = useCallback(async () => {
        setState({ checks: null, loading: true, error: null });
        try {
            const data = await analyticsFetch<DiagnoseResponse>(analyticsApi.diagnose());
            setState({ checks: data.checks || [], loading: false, error: null });
        } catch (e) {
            setState({ checks: null, loading: false, error: (e as Error).message });
        }
    }, []);

    return (
        <Card title={t('cms_site.analytics.settings.diagnose', 'Diagnose')} action={
            <button onClick={run} disabled={state.loading} style={secondaryBtnStyle}>
                {state.loading ? t('cms_site.analytics.settings.checking', 'Checking…') : t('cms_site.analytics.settings.run_checks', 'Run checks')}
            </button>
        }>
            {state.error ? <ErrorNote message={state.error} onRetry={run} compact />
                : !state.checks ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', margin: 0 }}>
                        {t('cms_site.analytics.settings.diagnose_intro', 'Checks the whole chain — switch, credentials, reachability, the script your visitors actually load, site registration and consent — and stops at the first thing that is broken.')}
                    </p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {state.checks.map(c => <CheckRow key={c.id} check={c} />)}
                    </div>
                )}
        </Card>
    );
}

export const CHECK_STYLE: Record<string, { color: string; mark: string }> = {
    pass: { color: '#10b981', mark: '✓' },
    warn: { color: '#f59e0b', mark: '!' },
    fail: { color: '#ef4444', mark: '✕' },
    skip: { color: 'var(--text-muted, #777)', mark: '–' },
    info: { color: 'var(--text-muted, #888)', mark: 'i' },
};

export function CheckRow({ check }: { check: DiagnoseCheck }) {
    const s = CHECK_STYLE[check.status] || CHECK_STYLE.info;
    return (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <span style={{
                width: 17, height: 17, borderRadius: 5, flexShrink: 0, marginTop: 1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800, background: `${s.color}1f`, color: s.color,
            }}>{s.mark}</span>
            <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary, #fff)' }}>{check.label}</div>
                {check.detail && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', wordBreak: 'break-word' }}>
                        {check.detail}
                    </div>
                )}
            </div>
        </div>
    );
}

/** Reachability + the internal/public URL split. */
export function ConnectionCard({ configured }: { configured?: boolean }) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ data: StatusResponse | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });

    const check = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const data = await analyticsFetch<StatusResponse>(analyticsApi.status());
            setState({ data, loading: false, error: null });
        } catch (e) {
            setState({ data: null, loading: false, error: (e as Error).message });
        }
    }, []);

    useEffect(() => { check(); }, [check]);

    const d = state.data;
    return (
        <Card title={t('cms_site.analytics.settings.connection', 'Connection')}>
            {state.loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted, #888)' }}>
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('cms_site.analytics.settings.checking', 'Checking…')}
                </div>
            ) : state.error ? (
                <ErrorNote message={state.error} onRetry={check} compact />
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                    <Row label={t('cms_site.analytics.settings.status', 'Status')} value={
                        d?.reachable
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#10b981', fontWeight: 700 }}>
                                <CheckCircle2 style={{ width: 13, height: 13 }} /> {d.websiteCount === 1
                                    ? t('cms_site.analytics.settings.connected_one', 'Connected · {n} website', { n: d.websiteCount })
                                    : t('cms_site.analytics.settings.connected_many', 'Connected · {n} websites', { n: d.websiteCount })}
                              </span>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: configured ? '#ef4444' : 'var(--text-muted, #888)', fontWeight: 700 }}>
                                <XCircle style={{ width: 13, height: 13 }} /> {configured ? t('cms_site.analytics.settings.not_reachable', 'Not reachable') : t('cms_site.analytics.settings.not_configured', 'Not configured')}
                              </span>
                    } />
                    <Row label={t('cms_site.analytics.settings.public_url', 'Public URL (browser)')} value={d?.publicUrl || '—'} mono />
                    <Row label={t('cms_site.analytics.settings.internal_url', 'Server URL (internal)')} value={d?.internalUrl || '—'} mono />
                    {d?.error && <ErrorNote message={d.error} onRetry={check} compact />}
                    {d?.usingInternalOverride && (
                        <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: 0 }}>
                            {rich(t('cms_site.analytics.settings.internal_note', '{code} is set on the server, so stats are fetched over the internal address while visitors load the tracker from the public one. These are meant to differ — if you point the internal one at localhost the server will try to call itself and every panel will fail.'), { code: 'UMAMI_URL' })}
                        </p>
                    )}
                    <button onClick={check} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>{t('cms_site.analytics.settings.test_again', 'Test again')}</button>
                </div>
            )}
        </Card>
    );
}

/** Per-site tracking state + the session-recording opt-in. */
export function SitesCard({ sites, onChanged }: { sites: SiteEntry[]; onChanged?: () => void }) {
    const { t } = useTranslation();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const toggleRecording = async (site: SiteEntry, next: boolean) => {
        setBusyId(site.id); setError(null);
        try {
            const res = await analyticsFetch<RecorderResponse>(analyticsApi.recorder(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ siteId: site.id, enabled: next }),
            });
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
            {error && <div style={{ marginBottom: 10 }}><ErrorNote message={error} compact /></div>}
            {tracked.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', margin: 0 }}>
                    {t('cms_site.analytics.settings.no_sites', 'No site is tracked yet. Publish a CMS site while tracking is enabled and it will appear here.')}
                </p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {tracked.map(site => (
                        <div key={site.id} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                            padding: '10px 12px', borderRadius: 10,
                            background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                        }}>
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary, #fff)' }}>
                                    {site.name}{site.live ? <span style={{ color: ACCENT, fontWeight: 600 }}> · {t('cms_site.analytics.settings.live', 'live')}</span> : null}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted, #777)', fontFamily: 'ui-monospace, monospace' }}>
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
                                {busyId === site.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video style={{ width: 13, height: 13 }} />}
                                {site.recording ? t('cms_site.analytics.settings.recording_on', 'Recording on') : t('cms_site.analytics.settings.record_sessions', 'Record sessions')}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-start', fontSize: 11, color: 'var(--text-muted, #888)' }}>
                <ShieldAlert style={{ width: 14, height: 14, marginTop: 1, flexShrink: 0, color: '#f59e0b' }} />
                <span>
                    {rich(t('cms_site.analytics.settings.recording_note', 'Session recording powers heatmaps and replays. It loads a larger script that captures clicks, scrolling and page structure, so it only ever runs for visitors who accepted your cookie banner — {modes}. Form inputs are masked. If your cookie banner is disabled, recording can never start.'), {
                        modes: <strong>{t('cms_site.analytics.settings.recording_modes', 'in every consent mode, including cookieless')}</strong>,
                    })}
                </span>
            </div>
        </Card>
    );
}

export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: 'var(--text-muted, #888)' }}>{label}</span>
            <span style={{
                color: 'var(--text-primary, #fff)', textAlign: 'right', wordBreak: 'break-all',
                fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: mono ? 11 : undefined,
            }}>{value}</span>
        </div>
    );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
    return (
        <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>{label}</label>
            {children}
            {hint && <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: '4px 0 0' }}>{hint}</p>}
        </div>
    );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>{label}</div>
                {hint && <div style={{ fontSize: 11, color: 'var(--text-muted, #777)' }}>{hint}</div>}
            </div>
            <button
                onClick={() => onChange(!checked)}
                aria-pressed={checked}
                style={{
                    width: 42, height: 24, borderRadius: 99, border: 'none', cursor: 'pointer', flexShrink: 0,
                    background: checked ? ACCENT : 'var(--bg-tertiary, rgba(255,255,255,0.12))',
                    position: 'relative', transition: 'background 0.15s',
                }}
            >
                <span style={{
                    position: 'absolute', top: 3, left: checked ? 21 : 3, width: 18, height: 18,
                    borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
                }} />
            </button>
        </div>
    );
}

export function ModeChip({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
    return (
        <button
            onClick={onClick}
            style={{
                flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                background: active ? `${ACCENT}14` : 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                border: `1px solid ${active ? `${ACCENT}66` : 'var(--border-default, rgba(255,255,255,0.08))'}`,
                transition: 'all 0.15s',
            }}
        >
            <div style={{ fontSize: 13, fontWeight: 700, color: active ? ACCENT : 'var(--text-primary, #fff)' }}>{title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', marginTop: 2 }}>{desc}</div>
        </button>
    );
}

export const inputStyle: CSSProperties = {
    width: '100%', boxSizing: 'border-box', marginTop: 5, padding: '8px 11px',
    background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))', borderRadius: 8, fontSize: 13,
};

export const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #ccc)' };

export const secondaryBtnStyle: CSSProperties = {
    padding: '6px 12px', borderRadius: 8, background: 'transparent',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
    color: 'var(--text-secondary, #aaa)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

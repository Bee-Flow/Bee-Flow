/**
 * Analytics settings.
 *
 * Connection + consent (as before), plus two things that were previously
 * impossible from the UI: per-site session-recording opt-in, and a connection
 * diagnostic that shows the internal-vs-public URL split — the standard way
 * this integration half-works (the browser loads /script.js fine from the
 * public origin while every server→Umami call quietly fails).
 */
import {
    ArrowLeft, ExternalLink, Globe, Loader2, ShieldAlert, Video, CheckCircle2, XCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { analyticsApi, analyticsFetch, type AnalyticsResponse, type AnalyticsSite } from '../../analyticsApi';
import { rich } from '../rich';
import { ACCENT, Card, ErrorNote } from '../ui';
import type { TrackerSettings, RecorderSettings, CheckItem, DiagnoseResponse, StatusResponse, RecorderResponse, SettingsSectionProps, RecorderCardProps, ConnectionCardProps, SitesCardProps, RowProps, FieldProps, ToggleProps, ModeChipProps } from './SettingsSection.types';

export default function SettingsSection({ settings, sites = [], onSaved, onSitesChanged, onClose }: SettingsSectionProps) {
    const { t } = useTranslation();
    const [enabled, setEnabled] = useState(!!settings?.enabled);
    const [consentMode, setConsentMode] = useState(settings?.consentMode || 'cookieless');
    const [url, setUrl] = useState(settings?.url || '');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [apiToken, setApiToken] = useState('');
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const [tracker, setTracker] = useState<TrackerSettings>(settings?.tracker || {});
    const [recorder, setRecorder] = useState<RecorderSettings>(settings?.recorder || {});
    const patchTracker = (k: string, v: string | boolean) => setTracker(prev => ({ ...prev, [k]: v }));
    const patchRecorder = (k: string, v: string | number) => setRecorder(r => ({ ...r, [k]: v }));

    const save = async () => {
        setSaving(true); setErr(null); setMsg(null);
        try {
            const body: Record<string, unknown> = { enabled, consentMode, url, tracker, recorder };
            // Only send credentials the operator actually typed, so a blank
            // field never wipes a stored secret.
            if (username) body.username = username;
            if (password) body.password = password;
            if (apiToken) body.apiToken = apiToken;
            const res = await analyticsFetch(analyticsApi.settings(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            // "Connected" would be a claim we cannot support: `configured` only
            // means the fields are non-empty, nothing has been probed. Point at
            // the diagnostic that actually checks.
            setMsg(res?.configured
                ? t('cms_site.analytics.settings.saved', 'Saved. Run the diagnostic below to confirm the whole chain works.')
                : t('cms_site.analytics.settings.saved_incomplete', 'Saved — add a URL and credentials to connect.'));
            setUsername(''); setPassword(''); setApiToken('');
            onSaved?.(res);
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="absolute inset-0 overflow-auto [background:var(--bg-primary)]">
            <div className="max-w-[720px] [margin:0_auto] [padding:24px_28px]">
                <div className="[display:flex] [align-items:center] [gap:10px] [margin-bottom:6px]">
                    {onClose && (
                        <button onClick={onClose} style={iconBtnStyle} title={t('cms_site.analytics.settings.back', 'Back to dashboard')}>
                            <ArrowLeft style={{ width: 15, height: 15 }} />
                        </button>
                    )}
                    <h2 className="[font-size:18px] [font-weight:800] [color:var(--text-primary,#fff)] [margin:0]">{t('cms_site.analytics.settings.title', 'Analytics settings')}</h2>
                </div>
                <p className="[font-size:12px] [color:var(--text-muted,#888)] [margin:0_0_20px]">
                    {t('cms_site.analytics.settings.intro', 'Connect your self-hosted Umami instance. Visitor data stays on your own infrastructure.')}
                </p>

                {err && <div className="[margin-bottom:14px]"><ErrorNote message={err} /></div>}
                {msg && <div className="[margin-bottom:14px] [padding:10px_14px] [border-radius:10px] [background:rgba(16,185,129,0.08)] [border:1px_solid_rgba(16,185,129,0.25)] [color:#6ee7b7] [font-size:13px]">{msg}</div>}

                <Card>
                    <Toggle label={t('cms_site.analytics.settings.enable', 'Enable tracking')} hint={t('cms_site.analytics.settings.enable_hint', 'Injects the tracker on your live published site.')} checked={enabled} onChange={setEnabled} />
                    <Field label={t('cms_site.analytics.settings.url', 'Umami URL')} hint={t('cms_site.analytics.settings.url_hint', "Public URL of your Umami instance, e.g. https://stats.your-domain.com. The visitor's browser loads the tracker from here.")}>
                        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://stats.example.com" style={inputStyle} />
                    </Field>

                    <div className="[margin:6px_0_14px]">
                        <label style={labelStyle}>{t('cms_site.analytics.settings.consent', 'Consent mode')}</label>
                        <div className="[display:flex] [gap:8px] [margin-top:6px]">
                            <ModeChip active={consentMode === 'cookieless'} onClick={() => setConsentMode('cookieless')} title={t('cms_site.analytics.settings.cookieless', 'Cookieless')} desc={t('cms_site.analytics.settings.cookieless_desc', 'No cookies, no consent banner needed')} />
                            <ModeChip active={consentMode === 'cookies'} onClick={() => setConsentMode('cookies')} title={t('cms_site.analytics.settings.cookies', 'Cookies')} desc={t('cms_site.analytics.settings.cookies_desc', 'Loads only after the visitor accepts cookies')} />
                        </div>
                        <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:6px_0_0]">
                            {t('cms_site.analytics.settings.cookies_note', 'In “Cookies” mode nothing is counted until a visitor presses Accept — including your own test visits.')}
                        </p>
                    </div>

                    <div className="[border-top:1px_solid_var(--border-default,rgba(255,255,255,0.08))] [margin:8px_0_14px] [padding-top:14px]">
                        <p style={sectionLabelStyle}>{settings?.configured ? t('cms_site.analytics.settings.credentials_stored', 'Credentials (stored — leave blank to keep)') : t('cms_site.analytics.settings.credentials', 'Credentials')}</p>
                        <Field label={t('cms_site.analytics.settings.username', 'Username')} hint={t('cms_site.analytics.settings.username_hint', 'Umami admin user (for token login).')}>
                            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder={settings?.configured ? '••••••••' : 'admin'} style={inputStyle} />
                        </Field>
                        <Field label={t('cms_site.analytics.settings.password', 'Password')}>
                            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={settings?.configured ? '••••••••' : ''} style={inputStyle} />
                        </Field>
                        <Field label={t('cms_site.analytics.settings.api_token', 'API token (optional)')} hint={t('cms_site.analytics.settings.api_token_hint', 'Use instead of username/password if your instance issues API keys.')}>
                            <input value={apiToken} onChange={(e) => setApiToken(e.target.value)} autoComplete="off" placeholder={settings?.configured ? '••••••••' : ''} style={inputStyle} />
                        </Field>
                    </div>

                    <div className="[display:flex] [align-items:center] [gap:10px] [margin-top:4px]">
                        <button onClick={save} disabled={saving} style={primaryBtnStyle}>
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {saving ? t('cms_site.analytics.settings.saving', 'Saving…') : t('cms_site.analytics.settings.save', 'Save settings')}
                        </button>
                        {url && (
                            <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: ACCENT, textDecoration: 'none' }}>
                                {t('cms_site.analytics.settings.open_umami', 'Open Umami')} <ExternalLink style={{ width: 12, height: 12 }} />
                            </a>
                        )}
                    </div>
                </Card>

                <div className="[margin-top:14px]">
                    <TrackerCard tracker={tracker} onChange={patchTracker} onSave={save} saving={saving} />
                </div>
                <div className="[margin-top:14px]">
                    <RecorderCard recorder={recorder} maskLevels={settings?.maskLevels} onChange={patchRecorder} />
                </div>
                <div className="[margin-top:14px]"><DiagnoseCard /></div>
                <div className="[margin-top:14px]"><ConnectionCard configured={settings?.configured} /></div>
                <div className="[margin-top:14px]"><SitesCard sites={sites} onChanged={onSitesChanged} /></div>

                <div className="[display:flex] [gap:8px] [margin-top:14px] [align-items:flex-start] [color:var(--text-muted,#888)] [font-size:12px]">
                    <Globe style={{ width: 14, height: 14, marginTop: 1, flexShrink: 0 }} />
                    <span>{t('cms_site.analytics.settings.website_note', 'A Umami "website" is created automatically per CMS site the first time you publish it (or save here while a site is live).')}</span>
                </div>
            </div>
        </div>
    );
}

/**
 * Tracker options mirrored onto the public <script> tag.
 *
 * Notably absent: a switch for web vitals. They are cookieless browser timings
 * riding along with a pageview already being sent under the same consent
 * decision — and making them optional is exactly how they ended up switched off
 * and unnoticed for the entire life of the feature.
 */
function TrackerCard({ tracker, onChange }: { tracker: TrackerSettings; onChange: (k: string, v: string | boolean) => void; onSave?: () => Promise<void>; saving?: boolean }) {
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
            <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:2px_0_0]">
                {t('cms_site.analytics.settings.tracker_note', "Saved with the button above. Changes apply on a visitor's next page load — no republish needed. Core Web Vitals are always collected: they are browser timings only, carried by the same request as the pageview.")}
            </p>
        </Card>
    );
}

function RecorderCard({ recorder, maskLevels = ['strict', 'moderate'], onChange }: RecorderCardProps) {
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
            <div className="[margin-bottom:6px]">
                <label style={labelStyle}>{t('cms_site.analytics.settings.masking', 'Input masking')}</label>
                <div className="[display:flex] [gap:8px] [margin-top:6px]">
                    {maskLevels.map(l => (
                        <ModeChip key={l} active={(recorder.maskLevel || 'strict') === l}
                            onClick={() => onChange('maskLevel', l)}
                            title={l === 'strict' ? t('cms_site.analytics.settings.mask_strict', 'Strict') : t('cms_site.analytics.settings.mask_moderate', 'Moderate')}
                            desc={l === 'strict' ? t('cms_site.analytics.settings.mask_strict_desc', 'Mask all text input')
                                : t('cms_site.analytics.settings.mask_moderate_desc', 'Mask passwords and marked fields')} />
                    ))}
                </div>
                {recorder.maskLevel === 'moderate' && (
                    <p className="[font-size:11px] [color:#fcd34d] [margin:6px_0_0]">
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
function DiagnoseCard() {
    const { t } = useTranslation();
    const [state, setState] = useState<{ checks: CheckItem[] | null; loading: boolean; error: string | null }>({ checks: null, loading: false, error: null });

    const run = useCallback(async () => {
        setState({ checks: null, loading: true, error: null });
        try {
            const data = await analyticsFetch(analyticsApi.diagnose()) as DiagnoseResponse | null;
            setState({ checks: data?.checks || [], loading: false, error: null });
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
                    <p className="[font-size:12px] [color:var(--text-muted,#888)] [margin:0]">
                        {t('cms_site.analytics.settings.diagnose_intro', 'Checks the whole chain — switch, credentials, reachability, the script your visitors actually load, site registration and consent — and stops at the first thing that is broken.')}
                    </p>
                ) : (
                    <div className="[display:flex] [flex-direction:column] [gap:8px]">
                        {state.checks.map((c: CheckItem) => <CheckRow key={c.id} check={c} />)}
                    </div>
                )}
        </Card>
    );
}

const CHECK_STYLE: Record<string, { color: string; mark: string; }> = {
    pass: { color: '#10b981', mark: '✓' },
    warn: { color: '#f59e0b', mark: '!' },
    fail: { color: '#ef4444', mark: '✕' },
    skip: { color: 'var(--text-muted, #777)', mark: '–' },
    info: { color: 'var(--text-muted, #888)', mark: 'i' },
};

function CheckRow({ check }: { check: CheckItem }) {
    const s = CHECK_STYLE[check.status] || CHECK_STYLE.info;
    return (
        <div className="[display:flex] [gap:9px] [align-items:flex-start]">
            <span style={{
                width: 17, height: 17, borderRadius: 5, flexShrink: 0, marginTop: 1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800, background: `${s.color}1f`, color: s.color,
            }}>{s.mark}</span>
            <div className="min-w-[0]">
                <div className="[font-size:12px] [color:var(--text-primary,#fff)]">{check.label}</div>
                {check.detail && (
                    <div className="[font-size:11px] [color:var(--text-muted,#888)] [word-break:break-word]">
                        {check.detail}
                    </div>
                )}
            </div>
        </div>
    );
}

function ConnectionCard({ configured }: ConnectionCardProps) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ data: StatusResponse | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });

    const check = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const data = await analyticsFetch(analyticsApi.status()) as StatusResponse | null;
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
                <div className="[display:flex] [align-items:center] [gap:8px] [font-size:12px] [color:var(--text-muted,#888)]">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('cms_site.analytics.settings.checking', 'Checking…')}
                </div>
            ) : state.error ? (
                <ErrorNote message={state.error} onRetry={check} compact />
            ) : (
                <div className="[display:flex] [flex-direction:column] [gap:8px] [font-size:12px]">
                    <Row label={t('cms_site.analytics.settings.status', 'Status')} value={
                        d?.reachable
                            ? <span className="[display:inline-flex] [align-items:center] [gap:5px] [color:#10b981] [font-weight:700]">
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
                        <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:0]">
                            {rich(t('cms_site.analytics.settings.internal_note', '{code} is set on the server, so stats are fetched over the internal address while visitors load the tracker from the public one. These are meant to differ — if you point the internal one at localhost the server will try to call itself and every panel will fail.'), { code: 'UMAMI_URL' })}
                        </p>
                    )}
                    <button onClick={check} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>{t('cms_site.analytics.settings.test_again', 'Test again')}</button>
                </div>
            )}
        </Card>
    );
}

function SitesCard({ sites, onChanged }: SitesCardProps) {
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
                                {busyId === site.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video style={{ width: 13, height: 13 }} />}
                                {site.recording ? t('cms_site.analytics.settings.recording_on', 'Recording on') : t('cms_site.analytics.settings.record_sessions', 'Record sessions')}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="[display:flex] [gap:8px] [margin-top:12px] [align-items:flex-start] [font-size:11px] [color:var(--text-muted,#888)]">
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

// ── Small inputs ─────────────────────────────────────────────────────

function Row({ label, value, mono }: RowProps) {
    return (
        <div className="[display:flex] [justify-content:space-between] [gap:12px]">
            <span className="[color:var(--text-muted,#888)]">{label}</span>
            <span style={{
                color: 'var(--text-primary, #fff)', textAlign: 'right', wordBreak: 'break-all',
                fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: mono ? 11 : undefined,
            }}>{value}</span>
        </div>
    );
}

function Field({ label, hint, children }: FieldProps) {
    return (
        <div className="[margin-bottom:14px]">
            <label style={labelStyle}>{label}</label>
            {children}
            {hint && <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:4px_0_0]">{hint}</p>}
        </div>
    );
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
    return (
        <div className="[display:flex] [align-items:center] [justify-content:space-between] [margin-bottom:14px]">
            <div>
                <div className="[font-size:13px] [font-weight:600] [color:var(--text-primary,#fff)]">{label}</div>
                {hint && <div className="[font-size:11px] [color:var(--text-muted,#777)]">{hint}</div>}
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

function ModeChip({ active, onClick, title, desc }: ModeChipProps) {
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
            <div className="[font-size:11px] [color:var(--text-muted,#888)] [margin-top:2px]">{desc}</div>
        </button>
    );
}

// ── Styles ───────────────────────────────────────────────────────────
const iconBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
    borderRadius: 8, background: 'var(--bg-secondary, #1a1a2e)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
    color: 'var(--text-secondary, #aaa)', cursor: 'pointer',
};
const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', marginTop: 5, padding: '8px 11px',
    background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))', borderRadius: 8, fontSize: 13,
};
const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #ccc)' };
const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-muted, #888)', margin: '0 0 10px',
};
const primaryBtnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 9,
    background: ACCENT, color: '#06241f', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
};
const secondaryBtnStyle: React.CSSProperties = {
    padding: '6px 12px', borderRadius: 8, background: 'transparent',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
    color: 'var(--text-secondary, #aaa)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

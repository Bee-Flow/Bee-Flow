/**
 * Analytics settings.
 *
 * Connection + consent (as before), plus two things that were previously
 * impossible from the UI: per-site session-recording opt-in, and a connection
 * diagnostic that shows the internal-vs-public URL split — the standard way
 * this integration half-works (the browser loads /script.js fine from the
 * public origin while every server→Umami call quietly fails).
 */
import { ArrowLeft, ExternalLink, Globe, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { analyticsApi, analyticsFetch, type AnalyticsResponse } from '../../analyticsApi';
import { rich } from '../rich';
import { Card, ErrorNote } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { TrackerSettings, RecorderSettings, CheckItem, DiagnoseResponse, StatusResponse, SettingsSectionProps, RecorderCardProps, ConnectionCardProps, RowProps, ModeChipProps } from './SettingsSection.types';
import { SitesCard } from './SitesCard';
import { TrackerCard, Field, Toggle, inputStyle, labelStyle } from './TrackerCard';

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
                            <ArrowLeft className="w-[15px] h-[15px]" />
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
                                {t('cms_site.analytics.settings.open_umami', 'Open Umami')} <ExternalLink className="w-[12px] h-[12px]" />
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
                    <Globe className="w-[14px] h-[14px] [margin-top:1px] [flex-shrink:0]" />
                    <span>{t('cms_site.analytics.settings.website_note', 'A Umami "website" is created automatically per CMS site the first time you publish it (or save here while a site is live).')}</span>
                </div>
            </div>
        </div>
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
                                <CheckCircle2 className="w-[13px] h-[13px]" /> {d.websiteCount === 1
                                    ? t('cms_site.analytics.settings.connected_one', 'Connected · {n} website', { n: d.websiteCount })
                                    : t('cms_site.analytics.settings.connected_many', 'Connected · {n} websites', { n: d.websiteCount })}
                              </span>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: configured ? '#ef4444' : 'var(--text-muted, #888)', fontWeight: 700 }}>
                                <XCircle className="w-[13px] h-[13px]" /> {configured ? t('cms_site.analytics.settings.not_reachable', 'Not reachable') : t('cms_site.analytics.settings.not_configured', 'Not configured')}
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

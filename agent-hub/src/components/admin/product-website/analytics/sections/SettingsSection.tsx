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
import { useTranslation } from '@/hooks/useTranslation';
import { analyticsApi, analyticsFetch, type AnalyticsResponse } from '../../analyticsApi';
import { rich } from '../rich';
import { Card, ErrorNote } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { TrackerSettings, RecorderSettings, CheckItem, DiagnoseResponse, StatusResponse, SettingsSectionProps, RecorderCardProps, ConnectionCardProps, RowProps, ModeChipProps } from './SettingsSection.types';
import { SitesCard } from './SitesCard';
import { TrackerCard, Field, Toggle, inputClass, labelClass } from './TrackerCard';
import { EYEBROW, PRIMARY_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import { pillClass } from '../ui';

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
        <div className="absolute inset-0 overflow-auto bg-[var(--bg-primary)]">
            <div className="max-w-[720px] mx-auto py-6 px-7">
                <div className="flex items-center gap-2.5 mb-1.5">
                    {onClose && (
                        <button type="button" onClick={onClose} className={ICON_BTN} title={t('cms_site.analytics.settings.back', 'Back to dashboard')} aria-label={t('cms_site.analytics.settings.back', 'Back to dashboard')}>
                            <ArrowLeft className="w-[15px] h-[15px]" />
                        </button>
                    )}
                    <h2 className="text-lg font-semibold text-[var(--text-primary)] m-0">{t('cms_site.analytics.settings.title', 'Analytics settings')}</h2>
                </div>
                <p className="text-xs text-[var(--text-tertiary)] mt-0 mx-0 mb-5">
                    {t('cms_site.analytics.settings.intro', 'Connect your self-hosted Umami instance. Visitor data stays on your own infrastructure.')}
                </p>

                {err && <div className="mb-3.5"><ErrorNote message={err} /></div>}
                {msg && <div className="mb-3.5 py-2.5 px-3.5 rounded-lg border border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success-ink)] text-[13px]">{msg}</div>}

                <Card>
                    <Toggle label={t('cms_site.analytics.settings.enable', 'Enable tracking')} hint={t('cms_site.analytics.settings.enable_hint', 'Injects the tracker on your live published site.')} checked={enabled} onChange={setEnabled} />
                    <Field label={t('cms_site.analytics.settings.url', 'Umami URL')} hint={t('cms_site.analytics.settings.url_hint', "Public URL of your Umami instance, e.g. https://stats.your-domain.com. The visitor's browser loads the tracker from here.")}>
                        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://stats.example.com" className={inputClass} />
                    </Field>

                    <div className="mt-1.5 mx-0 mb-3.5">
                        <label className={labelClass}>{t('cms_site.analytics.settings.consent', 'Consent mode')}</label>
                        <div className="flex gap-2 mt-1.5">
                            <ModeChip active={consentMode === 'cookieless'} onClick={() => setConsentMode('cookieless')} title={t('cms_site.analytics.settings.cookieless', 'Cookieless')} desc={t('cms_site.analytics.settings.cookieless_desc', 'No cookies, no consent banner needed')} />
                            <ModeChip active={consentMode === 'cookies'} onClick={() => setConsentMode('cookies')} title={t('cms_site.analytics.settings.cookies', 'Cookies')} desc={t('cms_site.analytics.settings.cookies_desc', 'Loads only after the visitor accepts cookies')} />
                        </div>
                        <p className="text-[11px] text-[var(--text-tertiary)] mt-1.5 mx-0 mb-0">
                            {t('cms_site.analytics.settings.cookies_note', 'In “Cookies” mode nothing is counted until a visitor presses Accept — including your own test visits.')}
                        </p>
                    </div>

                    <div className="border-t border-[var(--border-default)] mt-2 mx-0 mb-3.5 pt-3.5">
                        <p className={`${EYEBROW} mb-2.5`}>{settings?.configured ? t('cms_site.analytics.settings.credentials_stored', 'Credentials (stored — leave blank to keep)') : t('cms_site.analytics.settings.credentials', 'Credentials')}</p>
                        <Field label={t('cms_site.analytics.settings.username', 'Username')} hint={t('cms_site.analytics.settings.username_hint', 'Umami admin user (for token login).')}>
                            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder={settings?.configured ? '••••••••' : 'admin'} className={inputClass} />
                        </Field>
                        <Field label={t('cms_site.analytics.settings.password', 'Password')}>
                            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={settings?.configured ? '••••••••' : ''} className={inputClass} />
                        </Field>
                        <Field label={t('cms_site.analytics.settings.api_token', 'API token (optional)')} hint={t('cms_site.analytics.settings.api_token_hint', 'Use instead of username/password if your instance issues API keys.')}>
                            <input value={apiToken} onChange={(e) => setApiToken(e.target.value)} autoComplete="off" placeholder={settings?.configured ? '••••••••' : ''} className={inputClass} />
                        </Field>
                    </div>

                    <div className="flex items-center gap-2.5 mt-1">
                        <button type="button" onClick={save} disabled={saving} className={PRIMARY_BTN}>
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {saving ? t('cms_site.analytics.settings.saving', 'Saving…') : t('cms_site.analytics.settings.save', 'Save settings')}
                        </button>
                        {url && (
                            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline">
                                {t('cms_site.analytics.settings.open_umami', 'Open Umami')} <ExternalLink className="w-[12px] h-[12px]" />
                            </a>
                        )}
                    </div>
                </Card>

                <div className="mt-3.5">
                    <TrackerCard tracker={tracker} onChange={patchTracker} onSave={save} saving={saving} />
                </div>
                <div className="mt-3.5">
                    <RecorderCard recorder={recorder} maskLevels={settings?.maskLevels} onChange={patchRecorder} />
                </div>
                <div className="mt-3.5"><DiagnoseCard /></div>
                <div className="mt-3.5"><ConnectionCard configured={settings?.configured} /></div>
                <div className="mt-3.5"><SitesCard sites={sites} onChanged={onSitesChanged} /></div>

                <div className="flex gap-2 mt-3.5 items-start text-[var(--text-tertiary)] text-xs">
                    <Globe className="w-[14px] h-[14px] mt-[1px] shrink-0" />
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
                    className="mt-1.5 w-full accent-[var(--accent-primary)]" />
            </Field>
            <div className="mb-1.5">
                <label className={labelClass}>{t('cms_site.analytics.settings.masking', 'Input masking')}</label>
                <div className="flex gap-2 mt-1.5">
                    {maskLevels.map(l => (
                        <ModeChip key={l} active={(recorder.maskLevel || 'strict') === l}
                            onClick={() => onChange('maskLevel', l)}
                            title={l === 'strict' ? t('cms_site.analytics.settings.mask_strict', 'Strict') : t('cms_site.analytics.settings.mask_moderate', 'Moderate')}
                            desc={l === 'strict' ? t('cms_site.analytics.settings.mask_strict_desc', 'Mask all text input')
                                : t('cms_site.analytics.settings.mask_moderate_desc', 'Mask passwords and marked fields')} />
                    ))}
                </div>
                {recorder.maskLevel === 'moderate' && (
                    <p className="text-[11px] text-[var(--warning-ink)] mt-1.5 mx-0 mb-0">
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
            <button type="button" onClick={run} disabled={state.loading} className={SECONDARY_BTN}>
                {state.loading ? t('cms_site.analytics.settings.checking', 'Checking…') : t('cms_site.analytics.settings.run_checks', 'Run checks')}
            </button>
        }>
            {state.error ? <ErrorNote message={state.error} onRetry={run} compact />
                : !state.checks ? (
                    <p className="text-xs text-[var(--text-tertiary)] m-0">
                        {t('cms_site.analytics.settings.diagnose_intro', 'Checks the whole chain — switch, credentials, reachability, the script your visitors actually load, site registration and consent — and stops at the first thing that is broken.')}
                    </p>
                ) : (
                    <div className="flex flex-col gap-2">
                        {state.checks.map((c: CheckItem) => <CheckRow key={c.id} check={c} />)}
                    </div>
                )}
        </Card>
    );
}

const CHECK_STYLE: Record<string, { color: string; mark: string; }> = {
    pass: { color: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]', mark: '✓' },
    warn: { color: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]', mark: '!' },
    fail: { color: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]', mark: '✕' },
    skip: { color: 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]', mark: '–' },
    info: { color: 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]', mark: 'i' },
};

function CheckRow({ check }: { check: CheckItem }) {
    const s = CHECK_STYLE[check.status] || CHECK_STYLE.info;
    return (
        <div className="flex gap-[9px] items-start">
            <span className={`${s.color} mt-px inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold`}>{s.mark}</span>
            <div className="min-w-[0]">
                <div className="text-xs text-[var(--text-primary)]">{check.label}</div>
                {check.detail && (
                    <div className="text-[11px] text-[var(--text-tertiary)] break-words">
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
                <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('cms_site.analytics.settings.checking', 'Checking…')}
                </div>
            ) : state.error ? (
                <ErrorNote message={state.error} onRetry={check} compact />
            ) : (
                <div className="flex flex-col gap-2 text-xs">
                    <Row label={t('cms_site.analytics.settings.status', 'Status')} value={
                        d?.reachable
                            ? <span className="inline-flex items-center gap-[5px] text-[var(--success-ink)] font-semibold">
                                <CheckCircle2 className="w-[13px] h-[13px]" /> {d.websiteCount === 1
                                    ? t('cms_site.analytics.settings.connected_one', 'Connected · {n} website', { n: d.websiteCount })
                                    : t('cms_site.analytics.settings.connected_many', 'Connected · {n} websites', { n: d.websiteCount })}
                              </span>
                            : <span className={`inline-flex items-center gap-[5px] font-semibold ${configured ? 'text-[var(--error-ink)]' : 'text-[var(--text-tertiary)]'}`}>
                                <XCircle className="w-[13px] h-[13px]" /> {configured ? t('cms_site.analytics.settings.not_reachable', 'Not reachable') : t('cms_site.analytics.settings.not_configured', 'Not configured')}
                              </span>
                    } />
                    <Row label={t('cms_site.analytics.settings.public_url', 'Public URL (browser)')} value={d?.publicUrl || '—'} mono />
                    <Row label={t('cms_site.analytics.settings.internal_url', 'Server URL (internal)')} value={d?.internalUrl || '—'} mono />
                    {d?.error && <ErrorNote message={d.error} onRetry={check} compact />}
                    {d?.usingInternalOverride && (
                        <p className="text-[11px] text-[var(--text-tertiary)] m-0">
                            {rich(t('cms_site.analytics.settings.internal_note', '{code} is set on the server, so stats are fetched over the internal address while visitors load the tracker from the public one. These are meant to differ — if you point the internal one at localhost the server will try to call itself and every panel will fail.'), { code: 'UMAMI_URL' })}
                        </p>
                    )}
                    <button type="button" onClick={check} className={`${SECONDARY_BTN} self-start`}>{t('cms_site.analytics.settings.test_again', 'Test again')}</button>
                </div>
            )}
        </Card>
    );
}

// ── Small inputs ─────────────────────────────────────────────────────

function Row({ label, value, mono }: RowProps) {
    return (
        <div className="flex justify-between gap-3">
            <span className="text-[var(--text-tertiary)]">{label}</span>
            <span className={`break-all text-right text-[var(--text-primary)] ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</span>
        </div>
    );
}

function ModeChip({ active, onClick, title, desc }: ModeChipProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${active
                ? 'border-[var(--text-tertiary)] bg-[var(--bg-tertiary)]'
                : 'border-[var(--border-default)] hover:bg-[var(--bg-secondary)]'}`}
        >
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</div>
            <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{desc}</div>
        </button>
    );
}

// ── Styles ───────────────────────────────────────────────────────────
const ICON_BTN = 'grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] transition hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]';

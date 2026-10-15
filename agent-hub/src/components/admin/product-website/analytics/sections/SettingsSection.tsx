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
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { analyticsApi, analyticsFetch } from '../../analyticsApi';
import { rich } from '../rich';
import { ACCENT, Card, ErrorNote } from '../ui';

import type { ConsentMode, TrackerSettings, RecorderSettings, AnalyticsSettings, SiteEntry, SaveResponse, RecorderResponse, DiagnoseCheck, DiagnoseResponse, StatusResponse, SettingsSectionProps } from './SettingsSection.types';
import { TrackerCard, RecorderCard, DiagnoseCard, ConnectionCard, SitesCard, Field, Toggle, ModeChip, inputStyle, labelStyle } from './SettingsCards';
export type { ConsentMode, TrackerSettings, RecorderSettings, AnalyticsSettings, SiteEntry, SettingsSectionProps };
export default function SettingsSection({ settings, sites = [], onSaved, onSitesChanged, onClose }: SettingsSectionProps) {
    const { t } = useTranslation();
    const [enabled, setEnabled] = useState(!!settings?.enabled);
    const [consentMode, setConsentMode] = useState<ConsentMode>(settings?.consentMode || 'cookieless');
    const [url, setUrl] = useState(settings?.url || '');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [apiToken, setApiToken] = useState('');
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const [tracker, setTracker] = useState<TrackerSettings>(settings?.tracker || {});
    const [recorder, setRecorder] = useState<RecorderSettings>(settings?.recorder || {});
    const patchTracker = (k: keyof TrackerSettings, v: string | boolean) => setTracker(prev => ({ ...prev, [k]: v }));
    const patchRecorder = (k: keyof RecorderSettings, v: string | number) => setRecorder(r => ({ ...r, [k]: v }));

    const save = async () => {
        setSaving(true); setErr(null); setMsg(null);
        try {
            const body: Record<string, unknown> = { enabled, consentMode, url, tracker, recorder };
            // Only send credentials the operator actually typed, so a blank
            // field never wipes a stored secret.
            if (username) body.username = username;
            if (password) body.password = password;
            if (apiToken) body.apiToken = apiToken;
            const res = await analyticsFetch<SaveResponse>(analyticsApi.settings(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            // "Connected" would be a claim we cannot support: `configured` only
            // means the fields are non-empty, nothing has been probed. Point at
            // the diagnostic that actually checks.
            setMsg(res.configured
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
        <div className="absolute inset-0 overflow-auto" style={{ background: 'var(--bg-primary)' }}>
            <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 28px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    {onClose && (
                        <button onClick={onClose} style={iconBtnStyle} title={t('cms_site.analytics.settings.back', 'Back to dashboard')}>
                            <ArrowLeft style={{ width: 15, height: 15 }} />
                        </button>
                    )}
                    <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary, #fff)', margin: 0 }}>{t('cms_site.analytics.settings.title', 'Analytics settings')}</h2>
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', margin: '0 0 20px' }}>
                    {t('cms_site.analytics.settings.intro', 'Connect your self-hosted Umami instance. Visitor data stays on your own infrastructure.')}
                </p>

                {err && <div style={{ marginBottom: 14 }}><ErrorNote message={err} /></div>}
                {msg && <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', color: '#6ee7b7', fontSize: 13 }}>{msg}</div>}

                <Card>
                    <Toggle label={t('cms_site.analytics.settings.enable', 'Enable tracking')} hint={t('cms_site.analytics.settings.enable_hint', 'Injects the tracker on your live published site.')} checked={enabled} onChange={setEnabled} />
                    <Field label={t('cms_site.analytics.settings.url', 'Umami URL')} hint={t('cms_site.analytics.settings.url_hint', "Public URL of your Umami instance, e.g. https://stats.your-domain.com. The visitor's browser loads the tracker from here.")}>
                        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://stats.example.com" style={inputStyle} />
                    </Field>

                    <div style={{ margin: '6px 0 14px' }}>
                        <label style={labelStyle}>{t('cms_site.analytics.settings.consent', 'Consent mode')}</label>
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                            <ModeChip active={consentMode === 'cookieless'} onClick={() => setConsentMode('cookieless')} title={t('cms_site.analytics.settings.cookieless', 'Cookieless')} desc={t('cms_site.analytics.settings.cookieless_desc', 'No cookies, no consent banner needed')} />
                            <ModeChip active={consentMode === 'cookies'} onClick={() => setConsentMode('cookies')} title={t('cms_site.analytics.settings.cookies', 'Cookies')} desc={t('cms_site.analytics.settings.cookies_desc', 'Loads only after the visitor accepts cookies')} />
                        </div>
                        <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: '6px 0 0' }}>
                            {t('cms_site.analytics.settings.cookies_note', 'In “Cookies” mode nothing is counted until a visitor presses Accept — including your own test visits.')}
                        </p>
                    </div>

                    <div style={{ borderTop: '1px solid var(--border-default, rgba(255,255,255,0.08))', margin: '8px 0 14px', paddingTop: 14 }}>
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

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
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

                <div style={{ marginTop: 14 }}>
                    <TrackerCard tracker={tracker} onChange={patchTracker} onSave={save} saving={saving} />
                </div>
                <div style={{ marginTop: 14 }}>
                    <RecorderCard recorder={recorder} maskLevels={settings?.maskLevels} onChange={patchRecorder} />
                </div>
                <div style={{ marginTop: 14 }}><DiagnoseCard /></div>
                <div style={{ marginTop: 14 }}><ConnectionCard configured={settings?.configured} /></div>
                <div style={{ marginTop: 14 }}><SitesCard sites={sites} onChanged={onSitesChanged} /></div>

                <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'flex-start', color: 'var(--text-muted, #888)', fontSize: 12 }}>
                    <Globe style={{ width: 14, height: 14, marginTop: 1, flexShrink: 0 }} />
                    <span>{t('cms_site.analytics.settings.website_note', 'A Umami "website" is created automatically per CMS site the first time you publish it (or save here while a site is live).')}</span>
                </div>
            </div>
        </div>
    );
}

// ── Small inputs ─────────────────────────────────────────────────────

// ── Styles ───────────────────────────────────────────────────────────
const iconBtnStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
    borderRadius: 8, background: 'var(--bg-secondary, #1a1a2e)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
    color: 'var(--text-secondary, #aaa)', cursor: 'pointer',
};
const sectionLabelStyle: CSSProperties = {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-muted, #888)', margin: '0 0 10px',
};
const primaryBtnStyle: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 9,
    background: ACCENT, color: '#06241f', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
};

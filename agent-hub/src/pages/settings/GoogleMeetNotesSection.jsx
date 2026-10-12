import React, { useEffect, useState } from 'react';
import { Video } from 'lucide-react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { LANGS, Toggle, Row, Select } from './shared/settingsPrimitives';
import { openGoogleOAuthPopup } from '../../lib/googleOAuthPopup';
import { useTranslation } from '../../hooks/useTranslation';

// Google Meet brand colour, for the header icon only; the Save button uses the accent.
const MEET_GREEN = '#00832D';

/**
 * Personal Google Meet → Meeting Notes settings. Rendered for every account
 * that has the Meeting Notes feature; self-hides (renders null) when the
 * feature isn't licensed (the API returns a non-OK status) or Google isn't
 * connected. When Google is connected but the Meet scopes are missing it
 * renders a re-consent prompt instead of the settings rows. Org-level
 * settings, when present, take precedence over these per field.
 */
export default function GoogleMeetNotesSection() {
    const { t } = useTranslation();
    const [cfg, setCfg] = useState({ autoImport: false, autoRecordConfig: false, importScope: 'organizer', language: 'nl' });
    const [connection, setConnection] = useState(null);
    const [available, setAvailable] = useState(true);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [reauthing, setReauthing] = useState(false);
    const [message, setMessage] = useState(null);

    const load = async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/gmeet-notes-settings/user/me`);
            if (res.ok) {
                const { connection: conn, ...data } = await res.json();
                setConnection(conn || {});
                setCfg(prev => ({ ...prev, ...data }));
            } else setAvailable(false); // 403/404 → feature not licensed for this account
        } catch (_) { setAvailable(false); } finally { setLoading(false); }
    };
    useEffect(() => { load(); }, []);

    const save = async () => {
        setSaving(true); setMessage(null);
        try {
            const res = await authFetch(`${API_BASE}/api/gmeet-notes-settings/user/me`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
            });
            if (res.ok) setMessage({ type: 'success', text: t('common.saved', 'Saved') });
            else { const e = await res.json().catch(() => ({})); setMessage({ type: 'error', text: e.error || `HTTP ${res.status}` }); }
        } catch (e) { setMessage({ type: 'error', text: e.message }); }
        finally { setSaving(false); }
    };

    const reauthorize = async () => {
        setReauthing(true); setMessage(null);
        try {
            const result = await openGoogleOAuthPopup({ authFetch, apiBase: API_BASE });
            if (result.success) await load();
        } catch (e) { setMessage({ type: 'error', text: e.message || 'Could not start the Google re-authorization. Try again.' }); }
        finally { setReauthing(false); }
    };

    // Render nothing until we know — avoids flashing the section for accounts
    // that turn out to lack the feature or a Google connection.
    if (loading) return null;
    if (!available || !connection?.googleConnected) return null;

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <Video className="w-4 h-4" style={{ color: MEET_GREEN }} />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('settings.gmeet_notes.title', "Google Meet Meeting Notes")}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('settings.gmeet_notes.intro', "Turn your recorded Google Meet meetings into Meeting Notes — transcript, summary and action items. Per-meeting record toggles live in the Upcoming tab of Meeting Notes. Your organisation's settings, where set, take precedence.")}
            </p>

            {!connection.meetScopesGranted ? (
                <div className="rounded-xl px-5 py-4 border bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] border-[color-mix(in_srgb,var(--warning)_35%,transparent)]">
                    <p className="text-[12px] text-[var(--warning-ink)]">
                        {t('settings.gmeet_notes.reauth_notice', "Your Google account is connected, but Meeting Notes needs extra Google Meet permissions to import your meeting recordings. Re-authorize to grant them — your existing Gmail, Calendar and Drive access is kept.")}
                    </p>
                    <button
                        type="button" onClick={reauthorize} disabled={reauthing}
                        className="mt-2.5 px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--warning)] text-[var(--accent-primary-fg)]"
                    >
                        {reauthing ? t('settings.gmeet_notes.opening_google', 'Opening Google…') : t('settings.gmeet_notes.reauthorize', 'Re-authorize Google')}
                    </button>
                    {message && message.type === 'error' && (
                        <p className="text-[11px] mt-2 text-[var(--error-ink)]">{message.text}</p>
                    )}
                </div>
            ) : (
                <>
                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        <Row title={t('settings.gmeet_notes.auto_import_title', 'Auto-import my recorded Meet meetings')} desc={t('settings.gmeet_notes.auto_import_desc', 'When a recording of your Google Meet call appears in Drive, create a Meeting Note automatically. Recording must be started in Meet — requires Google Workspace Business Standard or higher.')}>
                            <Toggle on={cfg.autoImport} onClick={() => setCfg(c => ({ ...c, autoImport: !c.autoImport }))} disabled={saving} ariaLabel={t('settings.gmeet_notes.auto_import_title', 'Auto-import my recorded Meet meetings')} />
                        </Row>
                        <Row title={t('settings.gmeet_notes.auto_record_title', 'Also pre-enable auto-recording for meetings I organize')} desc={t('settings.gmeet_notes.auto_record_desc', 'Configure Meet to start recording automatically for meetings you organize, so nothing is missed.')}>
                            <Toggle on={cfg.autoRecordConfig} onClick={() => setCfg(c => ({ ...c, autoRecordConfig: !c.autoRecordConfig }))} disabled={saving} ariaLabel={t('settings.gmeet_notes.auto_record_title', 'Also pre-enable auto-recording for meetings I organize')} />
                        </Row>
                        <Row title={t('settings.gmeet_notes.scope_title', 'Which meetings')} desc={t('settings.gmeet_notes.scope_desc', 'Import only meetings you organize, or every Meet meeting on your calendar.')}>
                            <Select value={cfg.importScope} disabled={saving} onChange={e => setCfg(c => ({ ...c, importScope: e.target.value }))}
                                ariaLabel={t('settings.gmeet_notes.scope_title', 'Which meetings')}
                                options={[{ value: 'organizer', label: t('settings.gmeet_notes.scope_organizer', 'Meetings I organize') }, { value: 'calendar', label: t('settings.gmeet_notes.scope_calendar', 'All my calendar meetings') }]} />
                        </Row>
                        <Row title={t('settings.gmeet_notes.language_title', 'Default language')} desc={t('settings.gmeet_notes.language_desc', 'Language used when transcribing your Meet recordings.')}>
                            <select
                                value={cfg.language} onChange={e => setCfg(c => ({ ...c, language: e.target.value }))} disabled={saving}
                                aria-label={t('settings.gmeet_notes.language_title', 'Default language')}
                                className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                            >
                                {LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                            </select>
                        </Row>
                    </div>

                    <div className="flex items-center gap-3 mt-3">
                        <button
                            type="button" onClick={save} disabled={saving}
                            className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        >
                            {saving ? t('settings.gmeet_notes.saving', 'Saving…') : t('settings.gmeet_notes.save', 'Save')}
                        </button>
                        {message && (
                            <span className={`text-[12px] font-medium ${message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error)]'}`}>
                                {message.type === 'success' ? '✓' : '⚠'} {message.text}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

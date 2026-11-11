import React, { useState } from 'react';
import { API_BASE } from '../../utils/helpers';
import { useHasGoogleMapsKey } from '../../api/queries/settingsConsumer';
import { useTranslation } from '../../hooks/useTranslation';
import { mutate, ApiError } from '../../api/mutate';

/* ── Google Maps integration card ────────────────────────────────────────── */
/** The Google Maps key: instance-wide (POST /ai/config takes a platform admin). `mark` follows the name, e.g. the server-wide mark. */
const GoogleMapsRow = ({ mark = null }: { mark?: React.ReactNode }) => {
    const { t } = useTranslation();
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const storedKey = useHasGoogleMapsKey().data === true;
    const [justSaved, setHasKey] = useState(false);
    const hasKey = storedKey || justSaved;
    const [open, setOpen] = useState(false);

    const save = async () => {
        if (!key.trim()) return;
        setSaving(true);
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- an ApiError is shown by mutate(); anything else is logged to the browser console of the person who clicked, nothing is sent to a client
            const res = await mutate(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ googleMapsApiKey: key }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) { setHasKey(true); setKey(''); setOpen(false); }
        } catch (e) { console.error(e); }
        setSaving(false);
    };

    return (
        <div>
            <button
                className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors [background:var(--bg-secondary)]"
                onClick={() => setOpen(v => !v)}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
            >
                <div className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" fill="none" className="w-[18px] h-[18px]">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335" />
                        <circle cx="12" cy="9" r="2.5" fill="#fff" />
                    </svg>
                </div>
                <div className="flex-1 min-w-0">
                    <p className="flex items-center text-[13px] font-medium text-[var(--text-primary)]">Google Maps{mark}</p>
                    <p className="text-[11px] truncate text-[var(--text-muted)]">
                        {hasKey ? t('org.integ_maps_configured') : t('org.integ_maps_desc')}
                    </p>
                </div>
                {hasKey && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 [background:rgba(5,150,105,0.1)] [color:#059669]!">{t('settings.connected')}</span>
                )}
                <svg className={`flex-shrink-0 [color:var(--text-muted)] [width:13px] [height:13px] [transition:transform_150ms] ${open ? '[transform:rotate(90deg)]' : '[transform:none]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
            </button>
            {open && (
                <div className="px-5 pb-4 pt-2 space-y-2 [background:var(--bg-secondary)] [border-top:1px_solid_var(--border-subtle)]">
                    <div className="flex gap-2">
                        <input
                            type="password" value={key} onChange={e => setKey(e.target.value)}
                            placeholder={hasKey ? '••••••••••••••••' : t('org.integ_maps_desc')}
                            className="flex-1 px-3 py-2 rounded-lg border outline-none text-[13px] [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                            onKeyDown={e => e.key === 'Enter' && save()}
                        />
                        <button onClick={save} disabled={saving || !key.trim()}
                            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]">
                            {saving ? '…' : t('org.save_changes')}
                        </button>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)]">
                        {t('settings.org_integrations.maps_enable', 'Enable')} <strong>Directions API</strong>, <strong>Places API</strong> &amp; <strong>Maps Embed API</strong> {t('settings.org_integrations.maps_in', 'in')}{' '}
                        <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener noreferrer"
                            className="underline text-[var(--accent-primary)]">Google Cloud Console</a>
                    </p>
                </div>
            )}
        </div>
    );
};

export default GoogleMapsRow;

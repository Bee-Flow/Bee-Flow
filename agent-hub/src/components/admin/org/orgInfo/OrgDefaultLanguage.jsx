import { Check, Info } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';

// ── Org Default Language ───────────────────────────────────────────────────
const OrgDefaultLanguage = () => {
    const { t } = useTranslation();
    const [locales, setLocales] = useState([]);
    const [defaultLocale, setDefaultLocale] = useState('en');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        authFetch(`${API_BASE}/api/languages/org/default`)
            .then(r => r.json())
            .then(data => {
                if (data.defaultLocale) setDefaultLocale(data.defaultLocale);
                if (Array.isArray(data.locales)) setLocales(data.locales);
            })
            .catch(e => console.warn('[OrgInfoPanel] load locales failed', e))
            .finally(() => setLoading(false));
    }, []);

    const handleSave = async (code) => {
        setDefaultLocale(code);
        setSaving(true);
        setSaved(false);
        try {
            const res = await authFetch(`${API_BASE}/api/languages/org/default`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultLocale: code }),
            });
            if (res.ok) {
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            }
        } catch (e) { console.error(e); }
        setSaving(false);
    };

    if (loading || locales.length <= 1) return null;

    return (
        <div className="space-y-5">
            <div>
                <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('org.default_language')}</h2>
                <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.default_language_desc')}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ background: 'rgba(59,130,246,0.1)' }}>
                        <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('org.new_user_language')}</p>
                        <p className="text-[11px] text-[var(--text-muted)] mt-0.5 mb-3">
                            {t('org.new_user_language_desc')}
                        </p>
                        <div className="flex items-center gap-3">
                            <select
                                value={defaultLocale}
                                onChange={e => handleSave(e.target.value)}
                                disabled={saving}
                                className="px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-[var(--accent-primary)] transition-colors min-w-[200px]"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            >
                                {locales.map(l => (
                                    <option key={l.code} value={l.code}>{l.name}</option>
                                ))}
                            </select>
                            {saved && (
                                <span className="text-[11px] font-medium flex items-center gap-1" style={{ color: '#059669' }}>
                                    <Check className="w-3.5 h-3.5" /> {t('common.saved')}
                                </span>
                            )}
                            {saving && (
                                <span className="text-[11px] text-[var(--text-muted)]">{t('common.saving')}</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <div className="p-3 rounded-lg text-[12px] flex items-start gap-2"
                style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', color: 'var(--text-secondary)' }}>
                <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: '#3b82f6' }} />
                <span>
                    {t('org.default_language_info')}
                </span>
            </div>
        </div>
    );
};

export default OrgDefaultLanguage;

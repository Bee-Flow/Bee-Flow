import { KeyRound, Loader2, AlertCircle, Check } from 'lucide-react';
import React, { useId, useState } from 'react';
import { postForBody } from '../../api/postForBody';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';

/** Settings → Security: change the password of an account that has one. */
export default function ChangePassword() {
    const { t } = useTranslation();
    const id = useId();
    const [oldPassword, setOld] = useState('');
    const [newPassword, setNew] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [ok, setOk] = useState(false);

    const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        setErr(''); setOk(false);
        if (newPassword.length < 8) { setErr(t('reset.min_length', 'Password must be at least 8 characters')); return; }
        if (newPassword !== confirm) { setErr(t('login.passwords_no_match', 'Passwords do not match')); return; }
        setBusy(true);
        try {
            const { ok, body: data } = await postForBody(`${API_BASE}/auth/change-password`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPassword, newPassword }),
            });
            if (ok && data.success) {
                setOk(true); setOld(''); setNew(''); setConfirm('');
            } else {
                setErr(data.error || t('changepw.failed', 'Failed to change password'));
            }
        } catch (e) { setErr(t('login.connection_error', 'Connection error. Please try again.')); }
        finally { setBusy(false); }
    };

    const field = 'w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';
    const label = 'block text-xs font-medium text-[var(--text-secondary)] mb-1';

    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 space-y-4">
            <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-[var(--accent-primary)]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('changepw.title', 'Change password')}</h3>
            </div>
            <form onSubmit={submit} className="space-y-3" autoComplete="off">
                <div>
                    <label htmlFor={`${id}-current`} className={label}>{t('changepw.current', 'Current password')}</label>
                    <input id={`${id}-current`} type="password" value={oldPassword} onChange={e => setOld(e.target.value)} className={field} autoComplete="current-password" required />
                </div>
                <div>
                    <label htmlFor={`${id}-new`} className={label}>{t('changepw.new', 'New password')}</label>
                    <input id={`${id}-new`} type="password" value={newPassword} onChange={e => setNew(e.target.value)} className={field} autoComplete="new-password" minLength={8} required />
                </div>
                <div>
                    <label htmlFor={`${id}-confirm`} className={label}>{t('changepw.confirm', 'Confirm new password')}</label>
                    <input id={`${id}-confirm`} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} className={field} autoComplete="new-password" minLength={8} required />
                </div>
                {err && <p className="text-sm text-[var(--error-ink)] flex items-center gap-1.5"><AlertCircle className="w-4 h-4 shrink-0" /> {err}</p>}
                {ok && <p className="text-sm text-[var(--success-ink)] flex items-center gap-1.5"><Check className="w-4 h-4 shrink-0" /> {t('changepw.success', 'Password changed successfully.')}</p>}
                <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 flex items-center gap-2 bg-[var(--accent-primary)]">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {t('changepw.update', 'Update password')}
                </button>
            </form>
        </div>
    );
}

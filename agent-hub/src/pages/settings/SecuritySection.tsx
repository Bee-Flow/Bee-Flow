import { ShieldCheck, ShieldOff, Loader2, RefreshCw, KeyRound, AlertCircle, Check, Smartphone, Usb } from 'lucide-react';
import React, { useEffect, useId, useState } from 'react';
import PolicyAcknowledgements from './PolicyAcknowledgements';
import TokenVaultSection from './TokenVaultSection';
import { isUsableHere, proveWithSecurityKey, securityKeyErrorCode, securityKeysSupported } from '../../api/queries/securityKeys';
import McpTokensPanel from '../../components/mcpAccess/McpTokensPanel';
import AuthenticatorAppSetup from '../../components/mfa/AuthenticatorAppSetup';
import MfaHelpAssistant from '../../components/mfa/MfaHelpAssistant';
import RecoveryCodes from '../../components/mfa/RecoveryCodes';
import { securityKeyMessage } from '../../components/mfa/securityKeyMessages';
import SecurityKeysCard from '../../components/mfa/SecurityKeysCard';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import { AuthenticationResponseJSON } from '@simplewebauthn/browser';

interface MfaStatus {
    enabled: boolean;
    recoveryCodesRemaining: number;
    totpEnabled?: boolean;
    securityKeyRpIds?: string[];
    securityKeys?: number;
    hasPassword?: boolean;
}

interface ApiError { code?: string; message?: string }

/**
 * Personal security settings — TOTP MFA enrollment & management.
 * Talks to /auth/mfa/{status,setup,enable,disable,recovery-codes/regenerate}.
 */
const ChangePassword = () => {
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
            const res = await authFetch(`${API_BASE}/auth/change-password`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPassword, newPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
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
};

export default function SecuritySection() {
    const { t } = useTranslation();
    const disarmId = useId();
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<MfaStatus>({ enabled: false, recoveryCodesRemaining: 0 });
    // The status read failed: we do not know whether 2FA is on, so the screen
    // must not say "off" and offer Enable. It shows an error with a retry.
    const [statusError, setStatusError] = useState(false);
    const [statusRetrying, setStatusRetrying] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Enrollment flow
    const [setupData, setSetupData] = useState<{ qr: string; secret: string; serverTime?: number; otpauthUrl?: string } | null>(null); // { otpauthUrl, qr, secret, serverTime }
    const [code, setCode] = useState('');
    const [newCodes, setNewCodes] = useState<string[] | null>(null); // recovery codes shown once
    const [clockDriftSec, setClockDriftSec] = useState(0); // device vs server clock (BFSF-274)
    // Disable / regenerate flows
    const [disarmCode, setDisarmCode] = useState('');
    const [mode, setMode] = useState<string | null>(null); // null | 'disable' | 'regenerate'
    // Proof when adding an authenticator app while 2FA is already on and no
    // security key works on this address: a recovery code.
    const [enableProof, setEnableProof] = useState('');

    const loadStatus = async () => {
        try {
            const res = await authFetch(`${API_BASE}/auth/mfa/status`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setStatus(await res.json());
            setStatusError(false);
        } catch (_) { setStatusError(true); }
        finally { setLoading(false); }
    };
    useEffect(() => { loadStatus(); }, []);

    const retryStatus = async () => {
        setStatusRetrying(true);
        try { await loadStatus(); } finally { setStatusRetrying(false); }
    };

    // Translate server error codes instead of echoing raw English messages
    // (BFSF-274) — and make 429s human.
    const msgFor = (e: unknown) => {
        switch ((e as ApiError)?.code) {
            case 'invalid_code':
                return t('mfa.invalid_code', 'Invalid code. Check your authenticator app and try again.');
            case 'mfa_secret_unreadable':
                return t('mfa.secret_unreadable', 'Your authenticator can no longer be verified on this server. Use a recovery code, or ask your administrator to reset two-factor authentication.');
            case 'rate_limited':
                return t('mfa.too_many_attempts', 'Too many attempts — wait a few minutes and try again.');
            default:
                return (e as ApiError)?.message || t('mfa.request_failed', 'Request failed. Please try again.');
        }
    };

    const post = async (path: string, body?: { securityKey: AuthenticationResponseJSON; }|{ code: string; }|undefined) => {
        const res = await authFetch(`${API_BASE}/auth/mfa/${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err: Error & { code?: string } = new Error(data.error || 'Request failed');
            err.code = res.status === 429 ? 'rate_limited' : data.code;
            throw err;
        }
        return data;
    };

    const beginSetup = async () => {
        setError(''); setBusy(true);
        try {
            const data = await post('setup');
            setSetupData(data);
            // TOTP only tolerates ±30s of drift: warn when the device clock is
            // further off than that, since every code would be rejected with a
            // generic "Invalid code" otherwise.
            setClockDriftSec(data.serverTime ? Math.round((Date.now() - data.serverTime) / 1000) : 0);
        }
        catch (e) { setError(msgFor(e)); }
        finally { setBusy(false); }
    };

    // The factors 2FA is made of. A server that does not report totpEnabled
    // predates security keys, so its 2FA IS the authenticator app.
    const totpOn = status.enabled && status.totpEnabled !== false;
    const keyHere = securityKeysSupported() && (status.securityKeyRpIds || []).some((rp: string) => isUsableHere(rp));

    /** Proof of an existing factor from a key tap; null (with the reason shown) when it failed. */
    const tapKey = async () => {
        try { return await proveWithSecurityKey(); }
        catch (e) { setError(securityKeyMessage(securityKeyErrorCode(e), t)); return null; }
    };

    const confirmEnable = async () => {
        setError(''); setBusy(true);
        try {
            // Adding an app to an account whose 2FA is already on (security
            // keys only): prove one of those factors first.
            let proof;
            if (status.enabled) {
                proof = keyHere ? await tapKey() : { code: enableProof.trim() };
                if (!proof) return;
            }
            const data = await post('enable', { code: code.trim(), ...(proof ? { proof } : {}) });
            setNewCodes(data.recoveryCodes || []);
            setSetupData(null); setCode(''); setEnableProof('');
            await loadStatus();
        } catch (e) { setError(msgFor(e)); }
        finally { setBusy(false); }
    };

    const confirmDisarm = async (withKey: boolean = false) => {
        setError(''); setBusy(true);
        try {
            const proof = withKey ? await tapKey() : { code: disarmCode.trim() };
            if (!proof) return;
            if (mode === 'disable') {
                await post('disable', proof);
                setMode(null); setDisarmCode('');
                await loadStatus();
            } else if (mode === 'regenerate') {
                const data = await post('recovery-codes/regenerate', proof);
                setNewCodes(data.recoveryCodes || []);
                setMode(null); setDisarmCode('');
                await loadStatus();
            }
        } catch (e) { setError(msgFor(e)); }
        finally { setBusy(false); }
    };

    const inputClass = 'w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-center tracking-[0.25em] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';

    if (loading) {
        return <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>;
    }

    return (
        <div className="space-y-5">
            <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('settings.security', 'Security')}</h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">{t('mfa.section_desc', 'Add a second factor to protect your account at sign-in.')}</p>
            </div>

            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-[var(--error-ink)] text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" /> {error}
                </div>
            )}

            {/* One-time recovery codes display (after enable / regenerate) */}
            {newCodes ? (
                <RecoveryCodes codes={newCodes} onDone={() => setNewCodes(null)} />
            ) : setupData ? (
                /* Enrollment: QR + confirm code */
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 space-y-4">
                    {/* Steps incl. WHICH apps work, the QR, a tap-to-add link and the key */}
                    <AuthenticatorAppSetup otpauthUrl={setupData.otpauthUrl} qr={setupData.qr} secret={setupData.secret} />
                    {Math.abs(clockDriftSec) > 30 && (
                        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[var(--warning-ink)] text-xs flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            {t('mfa.time_drift_warning', 'Your device clock differs from the server by about {n} seconds — authenticator codes may be rejected. Enable automatic time on your device.', { n: Math.abs(clockDriftSec) })}
                        </div>
                    )}
                    <input className={inputClass} value={code} onChange={e => setCode(e.target.value)} placeholder="000000" inputMode="numeric" maxLength={6} aria-label={t('mfa.code', 'Verification code')} autoFocus />
                    {status.enabled && (keyHere ? (
                        <p className="text-xs text-[var(--text-secondary)]">{t('mfa.enable_confirm_with_key', 'After Enable, touch one of your security keys to confirm it is you.')}</p>
                    ) : (
                        <input className={inputClass} value={enableProof} onChange={e => setEnableProof(e.target.value)} placeholder={t('mfa.recovery_code_placeholder', 'xxxx-xxxx')} aria-label={t('mfa.recovery_code', 'Recovery code')} />
                    ))}
                    <div className="flex gap-2">
                        <button onClick={() => { setSetupData(null); setCode(''); setEnableProof(''); setError(''); }} className="flex-1 py-2.5 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-secondary)]">
                            {t('common.cancel', 'Cancel')}
                        </button>
                        <button onClick={confirmEnable} disabled={busy || code.trim().length < 6 || (status.enabled && !keyHere && !enableProof.trim())} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-2 bg-[var(--accent-primary)]">
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} {t('mfa.enable', 'Enable')}
                        </button>
                    </div>
                    {/* AI setup helper — takes no props by design: it must never
                        receive the QR/secret/code shown above (BFSF-274). */}
                    <MfaHelpAssistant />
                </div>
            ) : statusError ? (
                /* Status unknown: say so, never "off" */
                <div role="alert" data-testid="mfa-status-error" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 shrink-0 text-[var(--error)]" />
                        <div>
                            <div className="text-sm font-semibold text-[var(--text-primary)]">{t('mfa.title', 'Two-factor authentication')}</div>
                            <div className="text-xs text-[var(--error-ink)]">{t('mfa.request_failed', 'Request failed. Please try again.')}</div>
                        </div>
                    </div>
                    <button type="button" onClick={retryStatus} disabled={statusRetrying} className="shrink-0 px-4 py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-primary)] disabled:opacity-50 flex items-center gap-2">
                        {statusRetrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {t('error.try_again', 'Try again')}
                    </button>
                </div>
            ) : status.enabled ? (
                /* Enabled state */
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-[var(--success)]" />
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{t('mfa.enabled_title', 'Two-factor authentication is on')}</span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5" /> {t('mfa.codes_remaining', '{n} recovery codes remaining', { n: status.recoveryCodesRemaining })}
                    </p>
                    {status.recoveryCodesRemaining <= 3 && (
                        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[var(--warning-ink)] text-xs flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span className="flex-1">{t('mfa.codes_low_warning', 'You are running low on recovery codes. Regenerate a fresh set while you still have one to confirm with.')}</span>
                        </div>
                    )}

                    {mode ? (
                        <div className="space-y-2">
                            <label htmlFor={disarmId} className="text-xs font-medium text-[var(--text-secondary)]">
                                {totpOn
                                    ? t('mfa.confirm_with_code_or_recovery', 'Enter a 6-digit code or a recovery code to confirm')
                                    : t('mfa.confirm_with_recovery_or_key', 'Enter a recovery code, or confirm with your security key')}
                            </label>
                            {mode === 'disable' && (status.securityKeys as number) > 0 && (
                                <p className="text-xs text-[var(--warning-ink)]">
                                    {t('mfa.disable_removes_keys', 'Turning two-factor authentication off also removes your security keys.')}
                                </p>
                            )}
                            <input id={disarmId} className={inputClass} value={disarmCode} onChange={e => setDisarmCode(e.target.value)} placeholder={totpOn ? t('mfa.code_placeholder', '000000 or a1b2-c3d4') : 'a1b2-c3d4'} autoFocus />
                            {keyHere && (
                                <button onClick={() => confirmDisarm(true)} disabled={busy} className="w-full py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-primary)] flex items-center justify-center gap-1.5">
                                    <Usb className="w-4 h-4" /> {t('mfa.confirm_with_key', 'Confirm with security key')}
                                </button>
                            )}
                            <div className="flex gap-2">
                                <button onClick={() => { setMode(null); setDisarmCode(''); setError(''); }} className="flex-1 py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-secondary)]">
                                    {t('common.cancel', 'Cancel')}
                                </button>
                                <button onClick={() => confirmDisarm()} disabled={busy || !disarmCode.trim()} className={`flex-1 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-2 ${mode === 'disable' ? 'bg-red-600' : ''}`} style={mode === 'regenerate' ? { background: 'var(--accent-primary)' } : {}}>
                                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                    {mode === 'disable' ? t('mfa.disable', 'Disable') : t('mfa.regenerate', 'Regenerate')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {!totpOn && (
                                <button onClick={beginSetup} disabled={busy} className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                                    <Smartphone className="w-4 h-4" /> {t('mfa.add_authenticator', 'Add authenticator app')}
                                </button>
                            )}
                            <button onClick={() => { setMode('regenerate'); setError(''); }} className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                                <RefreshCw className="w-4 h-4" /> {t('mfa.regenerate_codes', 'Regenerate recovery codes')}
                            </button>
                            <button onClick={() => { setMode('disable'); setError(''); }} className="px-3 py-2 rounded-lg border border-red-500/30 text-sm font-medium text-[var(--error-ink)] flex items-center gap-1.5">
                                <ShieldOff className="w-4 h-4" /> {t('mfa.disable', 'Disable')}
                            </button>
                        </div>
                    )}
                </div>
            ) : (
                /* Disabled state */
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <ShieldOff className="w-5 h-5 text-[var(--text-muted)]" />
                        <div>
                            <div className="text-sm font-semibold text-[var(--text-primary)]">{t('mfa.disabled_title', 'Two-factor authentication is off')}</div>
                            <div className="text-xs text-[var(--text-muted)]">{t('mfa.disabled_desc', 'Use an authenticator app for an extra layer of security.')}</div>
                        </div>
                    </div>
                    <button onClick={beginSetup} disabled={busy} className="shrink-0 px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 flex items-center gap-2 bg-[var(--accent-primary)]">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} {t('mfa.enable', 'Enable')}
                    </button>
                </div>
            )}

            {/* Security keys (YubiKey etc.): a second factor on their own, next
                to or instead of the app. The first one turns 2FA on. */}
            {!setupData && !newCodes && !statusError && (
                <SecurityKeysCard mfaEnabled={!!status.enabled} totpEnabled={totpOn} onRecoveryCodes={setNewCodes} onChange={loadStatus} />
            )}

            {/* Change password — only for accounts that have a password */}
            {status.hasPassword && <ChangePassword />}

            {/* The user's own Privacy Shield placeholder dictionary. Lives here
                rather than under Privacy Shield because that section is
                consumer-only, and every account type has a vault. */}
            <TokenVaultSection />

            {/* Named tokens for external MCP clients (Claude Code, Cursor), each
                limited to the servers and tools chosen when it was made. */}
            <McpTokensPanel />

            {/* ISMS policies to read & confirm (renders nothing when none published) */}
            <PolicyAcknowledgements />
        </div>
    );
}

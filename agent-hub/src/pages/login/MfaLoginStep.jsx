import { ShieldCheck, Loader2, ArrowLeft, KeyRound, Usb, Smartphone } from 'lucide-react';
import React, { useState } from 'react';
import { securityKeysSupported } from '../../api/queries/securityKeys';
import { useTranslation } from '../../hooks/useTranslation';

const PRIMARY_BUTTON = 'w-full py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-xl font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-base shadow-lg shadow-amber-500/20';
const LINK_BUTTON = 'w-full py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center gap-1.5';

/** The code field and its submit button, for an authenticator or a recovery code. */
function CodeEntry({ code, setCode, recovery, isLoading, inputClass, labelClass }) {
    const { t } = useTranslation();
    return (
        <>
            <div>
                <label className={labelClass}>
                    {recovery ? t('mfa.recovery_code', 'Recovery code') : t('mfa.code', 'Verification code')}
                </label>
                <input
                    type="text"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    className={`${inputClass} text-center tracking-[0.3em] text-lg`}
                    placeholder={recovery ? 'xxxx-xxxx' : '000000'}
                    inputMode={recovery ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    autoFocus
                    data-testid="mfa-code-input"
                />
            </div>
            <button type="submit" disabled={isLoading || !code.trim()} data-testid="mfa-verify-button" className={PRIMARY_BUTTON}>
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><ShieldCheck className="w-5 h-5" /> {t('mfa.verify', 'Verify')}</>}
            </button>
        </>
    );
}

/** Links to every other way through the second step than the one on screen. */
function MethodSwitches({ view, hasTotp, keyAvailable, show }) {
    const { t } = useTranslation();
    return (
        <>
            {view !== 'code' && hasTotp && (
                <button type="button" onClick={() => show('code')} className={LINK_BUTTON}>
                    <Smartphone className="w-4 h-4" />
                    {t('mfa.use_authenticator', 'Use your authenticator app instead')}
                </button>
            )}
            {view !== 'key' && keyAvailable && (
                <button type="button" onClick={() => show('key')} className={LINK_BUTTON}>
                    <Usb className="w-4 h-4" />
                    {t('mfa.use_security_key_instead', 'Use your security key instead')}
                </button>
            )}
            {view !== 'recovery' && (
                <button type="button" onClick={() => show('recovery')} className={LINK_BUTTON}>
                    <KeyRound className="w-4 h-4" />
                    {t('mfa.use_recovery', 'Use a recovery code')}
                </button>
            )}
        </>
    );
}

const promptFor = (view, t) => {
    if (view === 'key') return t('mfa.security_key_touch', 'Insert your security key and touch it when it flashes.');
    if (view === 'recovery') return t('mfa.enter_recovery_code', 'Enter one of your one-time recovery codes');
    return t('mfa.enter_code', 'Enter the 6-digit code from your authenticator app');
};

/**
 * Second-factor entry shown when /auth/admin-login responds `mfaRequired`.
 * Submits the TOTP (or a recovery) code to /auth/mfa/verify-login, which
 * completes the session on success.
 *
 * When the account has a security key (`methods` includes 'security_key', from
 * the same /admin-login answer) and this browser can use one, the step opens
 * on the key instead: one button, which hands up to `onSecurityKey` so the
 * WebAuthn prompt starts from a click (Safari refuses it otherwise). The code
 * stays one link away, because a key only works on the host it was
 * registered on.
 *
 * An account may have no authenticator app at all (security keys only; then
 * `methods` lacks 'totp'). It is never offered a code it does not have, and
 * when its key cannot be used here it opens on the recovery code, saying why.
 */
const MfaLoginStep = ({ onVerify, onSecurityKey, methods = ['totp'], onCancel, isLoading, inputClass, labelClass }) => {
    const { t } = useTranslation();
    const hasTotp = methods.includes('totp');
    const keyAvailable = !!onSecurityKey && methods.includes('security_key') && securityKeysSupported();
    const keyStranded = !hasTotp && !keyAvailable && methods.includes('security_key');
    const [view, setView] = useState(keyAvailable ? 'key' : hasTotp ? 'code' : 'recovery'); // 'key' | 'code' | 'recovery'
    const [code, setCode] = useState('');

    const submit = (e) => {
        e.preventDefault();
        if (view !== 'key' && code.trim()) onVerify(code.trim());
    };
    const show = (next) => { setView(next); setCode(''); };

    return (
        <form onSubmit={submit} className="space-y-5" data-testid="mfa-login-step">
            <div className="flex flex-col items-center text-center gap-2">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-[var(--bg-primary)]">
                    {view === 'key'
                        ? <Usb className="w-6 h-6 text-[var(--accent-primary)]" />
                        : <ShieldCheck className="w-6 h-6 text-[var(--accent-primary)]" />}
                </div>
                <p className="text-sm text-[var(--text-secondary)]">{promptFor(view, t)}</p>
                {keyStranded && (
                    <p className="text-xs text-amber-500" data-testid="mfa-key-unavailable">
                        {t('mfa.security_key_not_here', 'Your security key cannot be used in this browser. Use a recovery code, or sign in from a browser that supports security keys.')}
                    </p>
                )}
            </div>

            {view === 'key' ? (
                <button type="button" onClick={() => onSecurityKey()} disabled={isLoading} data-testid="mfa-security-key-button" className={PRIMARY_BUTTON}>
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Usb className="w-5 h-5" /> {t('mfa.use_security_key', 'Use security key')}</>}
                </button>
            ) : (
                <CodeEntry code={code} setCode={setCode} recovery={view === 'recovery'} isLoading={isLoading} inputClass={inputClass} labelClass={labelClass} />
            )}

            <MethodSwitches view={view} hasTotp={hasTotp} keyAvailable={keyAvailable} show={show} />

            <button
                type="button"
                onClick={onCancel}
                className="w-full py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center gap-1.5"
            >
                <ArrowLeft className="w-4 h-4" /> {t('login.back', 'Back')}
            </button>

            {/* BFSF-274: a discoverable escalation path — before this, a user
                whose codes kept failing had no idea recovery even existed. */}
            <p className="text-xs text-center text-[var(--text-muted)]">
                {t('mfa.locked_out_hint', 'Locked out? Use a recovery code, or ask your organization admin to reset two-factor authentication for your account.')}
            </p>
        </form>
    );
};

export default MfaLoginStep;

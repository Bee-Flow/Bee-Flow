import React, { useState, useEffect, useEffectEvent, useRef } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';
import beeFlowIcon from '../../assets/bee-flow-logo.svg';

interface EmailVerificationScreenProps {
    verification?: { organizationName?: string } | null;
    t?: (key: string, fallback: string) => string;
}

/**
 * Shown inside the embedded Nextcloud view when the connector bootstrap matched
 * this Nextcloud's admin-email domain to an existing Bee Flow organisation and
 * is waiting for confirmation.
 *
 * On mount we ask the connector to email a one-time code to the admin who is
 * ACTUALLY doing the setup (the current NC user), not the arbitrary first admin
 * picked at bootstrap. That admin enters the code here to finish the link — all
 * in-app, no external Bee Flow login. They also become the org admin on success.
 */
function formatExpiresIn(expiresAt: string | null) {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'less than a minute';
    return `${mins} minute${mins === 1 ? '' : 's'}`;
}

const EmailVerificationScreen = ({ verification, t: tProp }: EmailVerificationScreenProps) => {
    const t = tProp || ((_k: string, d: string) => d);
    const v = verification || {};
    const orgName = v.organizationName || null;

    const [phase, setPhase] = useState('sending'); // sending | ready | blocked
    const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
    const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);

    const [code, setCode] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [resending, setResending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [, setTick] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const sentOnce = useRef(false);

    const requestCode = async ({ isResend = false }: { isResend?: boolean } = {}) => {
        if (isResend) setResending(true); else setPhase('sending');
        setError(null);
        setInfo(null);
        setAttemptsLeft(null);
        try {
            const res = await authFetch(`${API_BASE}/setup/request-verification-code`, { method: 'POST' });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body.ok) {
                setMaskedEmail(body.maskedEmail || null);
                setExpiresAt(body.expiresAt || null);
                setPhase('ready');
                if (isResend) {
                    setInfo(body.emailSent === false
                        ? t('app.nc_verify_email_unsent', 'We couldn’t send the email automatically — check the service email configuration.')
                        : t('app.nc_verify_resent', 'A new code is on its way. Check your inbox.'));
                }
                setTimeout(() => inputRef.current?.focus(), 0);
                return;
            }
            // Blocking conditions — no code input shown.
            if (body.code === 'not_admin') {
                setBlockedMsg(t('app.nc_verify_not_admin', 'Only a Nextcloud admin can finish connecting Bee Flow. Ask an administrator to open this page.'));
                setPhase('blocked');
            } else if (body.code === 'no_email') {
                setBlockedMsg(t('app.nc_verify_no_email', 'Your Nextcloud account has no email address. Add one in Nextcloud (Settings → Users), then reload this page.'));
                setPhase('blocked');
            } else if (body.code === 'email_not_in_org') {
                setBlockedMsg(orgName
                    ? t('app.nc_verify_not_in_org', 'Your Nextcloud account is not part of {org}. Sign in with an admin account on that organisation’s email domain.').replace('{org}', orgName)
                    : t('app.nc_verify_not_in_org_generic', 'Your Nextcloud account is not part of the organisation this Nextcloud is being linked to.'));
                setPhase('blocked');
            } else {
                // Transient/unknown — let them retry.
                setError(body.error || t('app.nc_verify_send_failed', 'Could not send the code. Please try again.'));
                setPhase('ready');
            }
        } catch (e) {
            setError(t('app.nc_verify_network', 'Could not reach Bee Flow. Check your connection and try again.'));
            setPhase('ready');
        } finally {
            if (isResend) setResending(false);
        }
    };

    // Send the code to the current admin once on mount.
    const sendFirstCode = useEffectEvent(() => requestCode());
    useEffect(() => {
        if (sentOnce.current) return;
        sentOnce.current = true;
        sendFirstCode();
    }, []);

    useEffect(() => {
        const id = setInterval(() => setTick((x: number) => x + 1), 30_000);
        return () => clearInterval(id);
    }, []);

    const expiresIn = formatExpiresIn(expiresAt);

    const submit = async () => {
        if (submitting || code.length !== 6) return;
        setSubmitting(true);
        setError(null);
        setInfo(null);
        try {
            const res = await authFetch(`${API_BASE}/setup/verify-email-code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body.ok) {
                window.location.reload();
                return;
            }
            if (typeof body.attemptsLeft === 'number') setAttemptsLeft(body.attemptsLeft);
            if (body.code === 'expired') {
                setError(t('app.nc_verify_expired', 'That code has expired. Request a new one below.'));
            } else if (body.code === 'too_many_attempts') {
                setError(t('app.nc_verify_too_many', 'Too many incorrect attempts. Request a new code below.'));
            } else if (body.code === 'invalid_code') {
                setError(t('app.nc_verify_invalid', 'That code is not correct. Check the email and try again.'));
            } else {
                setError(body.error || t('app.nc_verify_failed', 'Could not verify the code. Please try again.'));
            }
            setCode('');
            inputRef.current?.focus();
        } catch (e) {
            setError(t('app.nc_verify_network', 'Could not reach Bee Flow. Check your connection and try again.'));
        } finally {
            setSubmitting(false);
        }
    };

    const card = (children: React.ReactNode) => (
        <div className="h-[100vh] [display:flex] [align-items:center] [justify-content:center] [background:var(--bg-primary)] [padding:24px]">
            <div className="max-w-[420px] w-[100%] [text-align:center] [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)] [border-radius:24px] [padding:40px_32px] [box-shadow:0_20px_60px_rgba(0,0,0,0.15)]">
                <img src={beeFlowIcon} alt="Bee Flow" className="w-[64px] h-[64px] [border-radius:18px] [margin:0_auto_20px] [object-fit:contain] [display:block]" />
                {children}
            </div>
        </div>
    );

    if (phase === 'sending') {
        return card(
            <>
                <h2 className="[margin:0_0_10px] [font-size:18px] [font-weight:700] [color:var(--text-primary)]">
                    {t('app.nc_verify_title', 'Connect this Nextcloud')}
                </h2>
                <p className="[margin:0] [font-size:14px] [color:var(--text-secondary)]">
                    {t('app.nc_verify_sending', 'Sending a verification code to your email…')}
                </p>
            </>
        );
    }

    if (phase === 'blocked') {
        return card(
            <>
                <h2 className="[margin:0_0_10px] [font-size:18px] [font-weight:700] [color:var(--text-primary)]">
                    {t('app.nc_verify_title', 'Connect this Nextcloud')}
                </h2>
                <p className="[margin:0] [font-size:14px] [color:var(--text-secondary)] [line-height:1.65]">{blockedMsg}</p>
                <button
                    onClick={() => window.location.reload()}
                    className="[margin-top:20px] w-[100%] [padding:11px_0] [border-radius:12px] [background:var(--accent-primary)] [color:#fff] [font-weight:600] [font-size:14px] [border:none] [cursor:pointer]"
                >
                    {t('app.retry_connection', 'Reload')}
                </button>
            </>
        );
    }

    return card(
        <>
            <h2 className="[margin:0_0_10px] [font-size:18px] [font-weight:700] [color:var(--text-primary)]">
                {t('app.nc_verify_title', 'Connect this Nextcloud')}
            </h2>
            <p className="[margin:0_0_20px] [font-size:14px] [color:var(--text-secondary)] [line-height:1.65]">
                {orgName
                    ? t('app.nc_verify_desc_org', 'Enter the code we emailed to {email} to link this Nextcloud to {org}.')
                        .replace('{email}', maskedEmail || t('app.nc_verify_your_admin', 'your email'))
                        .replace('{org}', orgName)
                    : t('app.nc_verify_desc', 'Enter the code we emailed to {email} to link this Nextcloud to your Bee Flow organisation.')
                        .replace('{email}', maskedEmail || t('app.nc_verify_your_admin', 'your email'))}
            </p>

            <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') submit(); }}
                placeholder="••••••"
                aria-label={t('app.nc_verify_code_label', 'Verification code')}
                className="w-[100%] [box-sizing:border-box] [text-align:center] [font-size:30px] [font-weight:700] [letter-spacing:12px] [padding:14px_0] [margin-bottom:16px] [border-radius:12px] [border:1px_solid_var(--border-default)] [background:var(--bg-primary)] [color:var(--text-primary)] [font-family:monospace]"
            />

            {error && (
                <div className="[margin-bottom:14px] [font-size:13px] [border-radius:10px] [padding:10px_12px] [background:rgba(239,68,68,0.1)] [color:#ef4444] [line-height:1.5]">
                    {error}
                    {typeof attemptsLeft === 'number' && attemptsLeft > 0 && (
                        <div className="[margin-top:4px] [opacity:0.85]">
                            {t('app.nc_verify_attempts_left', '{n} attempts left').replace('{n}', String(attemptsLeft))}
                        </div>
                    )}
                </div>
            )}
            {info && !error && (
                <div className="[margin-bottom:14px] [font-size:13px] [border-radius:10px] [padding:10px_12px] [background:rgba(16,185,129,0.1)] [color:#059669] [line-height:1.5]">
                    {info}
                </div>
            )}

            <button
                onClick={submit}
                disabled={submitting || code.length !== 6}
                style={{
                    width: '100%', padding: '11px 0', borderRadius: 12,
                    background: 'var(--accent-primary)', color: '#fff', fontWeight: 600, fontSize: 14,
                    border: 'none', cursor: (submitting || code.length !== 6) ? 'not-allowed' : 'pointer',
                    opacity: (submitting || code.length !== 6) ? 0.55 : 1,
                }}
            >
                {submitting ? t('app.nc_verify_working', 'Verifying…') : t('app.nc_verify_submit', 'Verify & connect')}
            </button>

            <div className="[margin-top:16px] [font-size:13px] [color:var(--text-secondary)]">
                <button
                    onClick={() => requestCode({ isResend: true })}
                    disabled={resending}
                    style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: resending ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}
                >
                    {resending ? t('app.nc_verify_resending', 'Sending…') : t('app.nc_verify_resend', 'Resend code')}
                </button>
                {expiresIn && expiresIn !== 'expired' && (
                    <span className="[margin-left:8px] [opacity:0.8]">
                        {t('app.nc_verify_expires_in', 'Code expires in {time}').replace('{time}', expiresIn)}
                    </span>
                )}
            </div>
        </>
    );
};

export default EmailVerificationScreen;

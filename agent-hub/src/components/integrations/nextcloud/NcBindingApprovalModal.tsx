import React, { useState, useEffect } from 'react';
import { ShieldCheck, AlertTriangle, Copy, Check, X } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import { ALERT_ERROR, ALERT_WARNING, QUIET_BTN } from '@/components/shared/adminUi';
import { errorMessage } from '@/utils/caughtError';
import { logger } from '@/utils/logger';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

export interface PendingNcBinding {
    id: string;
    ncBaseUrl: string;
    ncInstanceId?: string;
    ncAdminUid?: string;
    ncAdminEmail?: string;
    ncVersion?: string;
    expiresAt?: string;
}

interface NcBindingApprovalModalProps {
    pending: PendingNcBinding | null;
    organizationName?: string | null;
    onResolved?: (action: 'approve' | 'deny') => void;
}

/**
 * Shown to org-admins when a Nextcloud connector is waiting to bind to
 * their existing Bee Flow org. The bootstrap on the SaaS side does NOT
 * auto-bind in this case — it parks a `pending_nc_bindings` row, and the
 * connector polls until this modal's Approve button mints the tenantKey.
 *
 * Why an explicit modal: the bootstrap caller is unauthenticated and
 * supplies the NC base URL itself, so an attacker hosting a fake NC could
 * otherwise adopt a victim's org by claiming the victim's email. The
 * authenticated approval here is the proof-of-ownership.
 */
function maskInstanceId(id: string | undefined) {
    if (!id) return '';
    if (id.length <= 16) return id;
    return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

/** "Expires in 5 minutes" in the viewer's language, or that it has expired; null without a deadline. */
function expiryText(t: TranslateFn, expiresAt: string | undefined, locale: string, now: number): string | null {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - now;
    if (!Number.isFinite(ms)) return null;
    if (ms <= 0) return t('admin_connections.nc_request_expired', 'This request has expired.');
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const mins = Math.max(1, Math.floor(ms / 60000));
    const when = mins < 60 ? rtf.format(mins, 'minute') : rtf.format(Math.floor(mins / 60), 'hour');
    return t('admin_connections.nc_request_expires', 'Expires {when}', { when });
}

const NcBindingApprovalModal = ({ pending, organizationName, onResolved }: NcBindingApprovalModalProps) => {
    const { t, resolvedLocale } = useTranslation();
    const [confirmed, setConfirmed] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    // Tick once a minute so the "expires in" text stays accurate while the
    // user reads the screen.
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);

    if (!pending) return null;

    const expiresIn = expiryText(t, pending.expiresAt, resolvedLocale, now);
    const orgName = organizationName || t('admin_connections.nc_this_organisation', 'this organisation');

    const submit = async (action: 'approve' | 'deny') => {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            try {
                await apiRequest(action === 'approve' ? 'POST /auth/admin/nc-bindings/{id}/approve' : 'POST /auth/admin/nc-bindings/{id}/deny', { params: { id: pending.id } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                throw new Error(body?.error || t('admin_connections.nc_request_failed', 'That did not work (HTTP {status}). Try again.', { status: err.status }));
            }
            onResolved?.(action);
        } catch (e) {
            setError(errorMessage(e) || String(e));
        } finally {
            setSubmitting(false);
        }
    };

    const copyInstanceId = async () => {
        try {
            await navigator.clipboard.writeText(pending.ncInstanceId || '');
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (err) { logger.debug('ignore', err); }
    };

    return (
        <div className="h-screen flex items-center justify-center p-4 [background:linear-gradient(160deg,var(--bg-primary)_0%,var(--bg-secondary)_50%,var(--bg-tertiary)_100%)]">
            <div className="w-full max-w-lg">
                <div className="rounded-2xl p-8 shadow-2xl border bg-[var(--bg-card)] border-[var(--border-default)]">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]">
                            <ShieldCheck className="w-6 h-6 text-[var(--warning-ink)]" aria-hidden="true" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('integ.nc_binding_approval_modal_confirm_nextcloud_connection', 'Confirm Nextcloud connection')}</h2>
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('integ.nc_binding_approval_modal_a_nextcloud_is_requesting_to_connect', 'A Nextcloud is requesting to connect to')} {orgName}.
                            </p>
                        </div>
                    </div>

                    <div className={`${ALERT_WARNING} mb-4`} role="note">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
                        <div className="[line-height:1.55]">
                            {t('integ.nc_binding_approval_modal_approve_only_if_this_is', 'Approve only if this is')} <strong>{t('integ.nc_binding_approval_modal_your', 'your')}</strong> {t('integ.nc_binding_approval_modal_nextcloud_once_approved_this_nextcloud', 'Nextcloud. Once approved, this Nextcloud can read and write data on behalf of users in your organisation.')}
                        </div>
                    </div>

                    <dl className="space-y-3 mb-4 text-sm">
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{t('integ.nc_binding_approval_modal_nextcloud_url', 'Nextcloud URL')}</dt>
                            <dd className="font-mono text-sm break-all text-[var(--text-primary)]">{pending.ncBaseUrl}</dd>
                        </div>
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{t('integ.nc_binding_approval_modal_instance_id', 'Instance ID')}</dt>
                            <dd className="flex items-center gap-2 font-mono text-sm text-[var(--text-primary)]">
                                <span title={pending.ncInstanceId}>{maskInstanceId(pending.ncInstanceId)}</span>
                                <button
                                    type="button"
                                    onClick={copyInstanceId}
                                    className={QUIET_BTN}
                                >
                                    {copied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
                                    {copied ? t('admin_connections.copied', 'Copied') : t('admin_connections.copy', 'Copy')}
                                </button>
                            </dd>
                            <p className="text-[11px] mt-1 text-[var(--text-secondary)]">
                                {t('integ.nc_binding_approval_modal_verify_this_matches', 'Verify this matches')} <code>occ config:system:get instanceid</code> {t('integ.nc_binding_approval_modal_on_your_nextcloud', 'on your Nextcloud.')}
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <dt className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{t('integ.nc_binding_approval_modal_nc_admin', 'NC admin')}</dt>
                                <dd className="text-sm text-[var(--text-primary)]">{pending.ncAdminUid}</dd>
                                <dd className="text-xs text-[var(--text-secondary)]">{pending.ncAdminEmail}</dd>
                            </div>
                            <div>
                                <dt className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{t('integ.nc_binding_approval_modal_nc_version', 'NC version')}</dt>
                                <dd className="text-sm text-[var(--text-primary)]">{pending.ncVersion || t('admin_connections.nc_version_unknown', 'Unknown')}</dd>
                                {expiresIn && (
                                    <dd className="text-xs text-[var(--text-secondary)]">{expiresIn}</dd>
                                )}
                            </div>
                        </div>
                    </dl>

                    <label className="flex items-start gap-2 mb-4 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmed(e.target.checked)}
                            className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent-primary)]"
                        />
                        <span className="text-sm text-[var(--text-primary)]">
                            {t('integ.nc_binding_approval_modal_i_recognise_this_nextcloud_and_want_to', 'I recognise this Nextcloud and want to connect it to')} {orgName}.
                        </span>
                    </label>

                    {error && (
                        <div role="alert" className={`${ALERT_ERROR} mb-3`}>
                            {error}
                        </div>
                    )}

                    <div className="flex gap-3">
                        <Button variant="secondary" icon={X} className="flex-1" disabled={submitting} onClick={() => submit('deny')}>
                            {t('integ.nc_binding_approval_modal_deny', 'Deny')}
                        </Button>
                        <Button variant="primary" className="flex-1" busy={submitting} disabled={!confirmed} onClick={() => submit('approve')}>
                            {submitting ? t('admin_connections.nc_working', 'Working…') : t('admin_connections.nc_approve', 'Approve and connect')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NcBindingApprovalModal;

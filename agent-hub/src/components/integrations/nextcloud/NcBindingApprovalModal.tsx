import React, { useState, useEffect } from 'react';
import { ShieldCheck, AlertTriangle, Copy, Check, X } from 'lucide-react';
import { API_BASE } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorMessage } from '../../../utils/caughtError';
import { logger } from '../../../utils/logger';
import { mutate, errorBody, RefusedError } from '../../../api/mutate';

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

function formatExpiresIn(expiresAt: string | undefined) {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'less than a minute';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} hour${hrs === 1 ? '' : 's'}`;
}

const NcBindingApprovalModal = ({ pending, organizationName, onResolved }: NcBindingApprovalModalProps) => {
    const { t } = useTranslation();
    const [confirmed, setConfirmed] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [, setTick] = useState(0);

    // Tick once a minute so the "expires in" text stays accurate while the
    // user reads the screen.
    useEffect(() => {
        const t = setInterval(() => setTick((x: number) => x + 1), 60_000);
        return () => clearInterval(t);
    }, []);

    if (!pending) return null;

    const expiresIn = formatExpiresIn(pending.expiresAt);

    const submit = async (action: 'approve' | 'deny') => {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            try {
                await mutate(`${API_BASE}/auth/admin/nc-bindings/${pending.id}/${action}`, {
                method: 'POST',
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                throw new Error(body?.error || `${action} failed (HTTP ${err.status})`);
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
                <div className="backdrop-blur-xl rounded-3xl p-8 shadow-2xl border bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 rounded-2xl flex items-center justify-center [background:rgba(245,158,11,0.12)]">
                            <ShieldCheck className="w-6 h-6 [color:#f59e0b]" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('integ.nc_binding_approval_modal_confirm_nextcloud_connection', 'Confirm Nextcloud connection')}</h2>
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('integ.nc_binding_approval_modal_a_nextcloud_is_requesting_to_connect', 'A Nextcloud is requesting to connect to')} {organizationName || 'your organisation'}.
                            </p>
                        </div>
                    </div>

                    <div
                        className="rounded-xl border p-4 mb-4 flex items-start gap-3 [border-color:rgba(245,158,11,0.4)] [background:rgba(245,158,11,0.06)]"
                    >
                        <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 [color:#f59e0b]" />
                        <div className="text-xs [color:var(--text-primary)]! [line-height:1.55]">
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
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                                >
                                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    {copied ? 'Copied' : 'Copy'}
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
                                <dd className="text-sm text-[var(--text-primary)]">{pending.ncVersion || 'unknown'}</dd>
                                {expiresIn && (
                                    <dd className="text-xs text-[var(--text-secondary)]">{t('integ.nc_binding_approval_modal_expires_in', 'Expires in {when}', { when: expiresIn })}</dd>
                                )}
                            </div>
                        </div>
                    </dl>

                    <label className="flex items-start gap-2 mb-4 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmed(e.target.checked)}
                            className="mt-0.5"
                        />
                        <span className="text-sm text-[var(--text-primary)]">
                            {t('integ.nc_binding_approval_modal_i_recognise_this_nextcloud_and_want_to', 'I recognise this Nextcloud and want to connect it to')} {organizationName || 'this organisation'}.
                        </span>
                    </label>

                    {error && (
                        <div className="mb-3 text-sm rounded-lg p-2 [background:rgba(239,68,68,0.1)] [color:#ef4444]!">
                            {error}
                        </div>
                    )}

                    <div className="flex gap-3">
                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => submit('deny')}
                            className="flex-1 py-2.5 rounded-xl font-medium text-sm border transition-colors disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                        >
                            <X className="inline w-4 h-4 mr-1" /> {t('integ.nc_binding_approval_modal_deny', 'Deny')}
                        </button>
                        <button
                            type="button"
                            disabled={!confirmed || submitting}
                            onClick={() => submit('approve')}
                            className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-50 bg-[var(--accent-primary)]"
                        >
                            {submitting ? 'Working…' : 'Approve and connect'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NcBindingApprovalModal;

import { ShieldCheck, Key, AlertCircle, Loader2, X } from 'lucide-react';
import React, { useState, useCallback } from 'react';
import { useLicenseContext } from './LicenseContext';
import { ServerLicenseFacts, ServerLicenseToken, ServerLicenseWarning } from './ServerLicenseParts';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';
import { useLicenseStatus } from '../../api/queries/serverLicense';
import useConfirm from '../shared/useConfirm';
import { messageOf } from '../../utils/caughtError';
import { mutate, errorBody, RefusedError } from '../../api/mutate';
import SectionHeader from '../shared/SectionHeader';
import { SettingRow, SettingsList } from '../shared/SettingsList';
import { ALERT_ERROR, ALERT_INFO, CHIP, CHIP_SUCCESS, CHIP_WARNING, DANGER_BTN, PRIMARY_BTN, SECONDARY_BTN } from '../mcpLibrary/ui';

interface ServerLicenseRecord {
    tier?: string;
    expiresAt?: string | null;
    issuer?: string;
    billingInterval?: string;
}

interface LicenseStatus {
    serverLicense?: ServerLicenseRecord | null;
    scope?: string;
    serverOverride?: boolean;
    license?: ServerLicenseRecord | null;
}

interface LicenseActionResponse {
    code?: string;
    error?: string;
    message?: string;
}

/**
 * ServerLicensePanel — super-admin entry point for activating ONE licence
 * key that governs the entire install. Per-org licences are overridden
 * while a server-wide licence is active.
 *
 * Available to super-admins on any deployment mode; the surrounding /admin
 * tab gates on superAdminOnly and the backend re-asserts the super-admin
 * check on activate/deactivate.
 */

const TIER_BADGE: Record<string, { label: string; chip: string }> = {
    community: { label: 'Community', chip: CHIP },
    enterprise: { label: 'Enterprise', chip: CHIP_SUCCESS },
    full: { label: 'Full', chip: CHIP_WARNING },
};

export default function ServerLicensePanel() {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { reload: reloadLicenseContext } = useLicenseContext();
    const statusQuery = useLicenseStatus<LicenseStatus>();
    const status = statusQuery.data ?? null;
    const loading = statusQuery.isFetching;
    const [tokenInput, setTokenInput] = useState('');
    const [showInput, setShowInput] = useState(false);
    const [busy, setBusy] = useState<'activate' | 'deactivate' | null>(null); // 'activate' | 'deactivate'
    const [mutationError, setActionError] = useState<string | null>(null);
    const actionError = mutationError ?? (statusQuery.isError ? messageOf(statusQuery.error, 'Failed to load licence status') : null);

    // Pull the server-wide licence status. The server-side getLicenseStatus
    // returns the server-scope row with serverOverride:true when present,
    // regardless of the caller's org — so a plain GET /status suffices.
    const { refetch } = statusQuery;
    const reload = useCallback(async () => {
        setActionError(null);
        await refetch();
    }, [refetch]);

    // `serverLicense` is present whenever a server-wide row exists, regardless
    // of deployment mode — so the panel shows/manages the licence on cloud too
    // (where it no longer overrides per-org billing). `serverOverride` only
    // reflects whether it currently governs the install, which we surface as a
    // hint. Fall back to the legacy override shape for older API responses.
    const serverLicense = status?.serverLicense
        || (status?.scope === 'server' && status?.serverOverride ? status?.license : null);
    const isServerScope = !!serverLicense;
    const isGoverning = status?.serverOverride === true;
    const tier = serverLicense?.tier || 'community';
    const badge = TIER_BADGE[tier] || TIER_BADGE.community;

    const handleActivate = async () => {
        const token = tokenInput.trim();
        if (!token) return;
        // Hard confirm — this is destructive (overrides every per-org licence).
        const ok = await confirm({
            title: t('admin.server_license.confirm_activate',
                'Activating a server-wide licence overrides EVERY existing organisation licence on this install. Every org runs at the server-wide tier while this licence is active. Continue?'),
            confirmLabel: t('admin.server_license.activate', 'Apply server-wide licence'),
            destructive: true,
        });
        if (!ok) return;
        setBusy('activate');
        setActionError(null);
        try {
            try {
                await mutate(`${API_BASE}/api/license/activate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, scope: 'server' }),
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = (errorBody(err) ?? {}) as LicenseActionResponse;
                const code = data.code || data.error;
                const msg = data.message || data.error || `HTTP ${err.status}`;
                throw new Error(`${msg}${code ? ` (${code})` : ''}`);
            }
            setTokenInput('');
            setShowInput(false);
            await reload();
            // Bubble out so the rest of the UI re-derives features.
            reloadLicenseContext && reloadLicenseContext();
        } catch (e) {
            setActionError(messageOf(e, 'Activation failed'));
        } finally {
            setBusy(null);
        }
    };

    const handleDeactivate = async () => {
        const ok = await confirm({
            title: t('admin.server_license.confirm_deactivate',
                'Remove the server-wide licence? Every organisation will revert to its own per-organisation licence (or Community fallback) on the next request.'),
            confirmLabel: t('admin.server_license.deactivate', 'Deactivate'),
            destructive: true,
        });
        if (!ok) return;
        setBusy('deactivate');
        setActionError(null);
        try {
            try {
                await mutate(`${API_BASE}/api/license/deactivate?scope=server`, { method: 'DELETE' });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                if (err.status !== 404) {
                    const data = (errorBody(err) ?? {}) as LicenseActionResponse;
                    throw new Error(data.error || `HTTP ${err.status}`);
                }
            }
            await reload();
            reloadLicenseContext && reloadLicenseContext();
        } catch (e) {
            setActionError(messageOf(e, 'Deactivation failed'));
        } finally {
            setBusy(null);
        }
    };

    const header = (
        <SectionHeader
            title={t('admin.server_license.title', 'Server licence')}
            description={t('admin.server_license.intro', 'One licence key applied install-wide. Every organisation on this server runs at the tier this licence carries; per-organisation licences are ignored while this is active.')}
        />
    );

    if (loading) {
        return (
            <div className="flex max-w-4xl flex-col gap-4" aria-busy="true">
                {header}
                <SettingsList className="animate-pulse">
                    <div className="px-4 py-3"><div className="h-4 w-48 rounded bg-[var(--bg-tertiary)]" /></div>
                    <div className="px-4 py-3"><div className="h-4 w-64 rounded bg-[var(--bg-tertiary)]" /></div>
                </SettingsList>
            </div>
        );
    }

    const actions = isServerScope ? (
        <div className="flex flex-wrap items-center gap-2 @[40rem]/srow:justify-end">
            <button type="button" onClick={() => setShowInput((v: boolean) => !v)} className={SECONDARY_BTN} disabled={!!busy}>
                <Key className="h-3.5 w-3.5" aria-hidden="true" />
                {t('admin.server_license.replace', 'Replace licence')}
            </button>
            <button type="button" onClick={handleDeactivate} className={DANGER_BTN} disabled={!!busy}>
                {busy === 'deactivate'
                    ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('admin.server_license.deactivating', 'Deactivating…')}</>)
                    : (t('admin.server_license.deactivate', 'Deactivate'))}
            </button>
        </div>
    ) : (
        <div className="flex @[40rem]/srow:justify-end">
            <button type="button" onClick={() => setShowInput(true)} className={PRIMARY_BTN} disabled={!!busy}>
                <Key className="h-3.5 w-3.5" aria-hidden="true" />
                {t('admin.server_license.activate', 'Apply server-wide licence')}
            </button>
        </div>
    );

    return (
        <div className="flex max-w-4xl flex-col gap-4">
            {header}

            <SettingsList>
                <SettingRow
                    icon={<ShieldCheck className="h-4 w-4" />}
                    label={isServerScope
                        ? t('admin.server_license.active_badge', 'Server-wide licence active')
                        : t('admin.server_license.inactive_badge', 'No server-wide licence applied')}
                    hint={<span className={badge.chip}>{badge.label}</span>}
                >
                    {actions}
                </SettingRow>
                {isServerScope && serverLicense ? <ServerLicenseFacts licence={serverLicense} /> : null}
                {showInput ? (
                    <ServerLicenseToken
                        value={tokenInput}
                        onChange={setTokenInput}
                        busy={busy}
                        onCancel={() => { setShowInput(false); setTokenInput(''); setActionError(null); }}
                        onActivate={handleActivate}
                    />
                ) : null}
            </SettingsList>

            {/* On cloud a server licence exists but does NOT govern per-org
                billing — make that explicit so an operator isn't surprised
                that orgs still need their own subscription. */}
            {isServerScope && !isGoverning && (
                <div className={ALERT_INFO}>
                    {t('admin.server_license.not_governing', 'This licence is recorded but does not cover organisations on this deployment — each organisation still needs its own subscription.')}
                </div>
            )}

            {actionError && (
                <div className={ALERT_ERROR} role="alert">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="flex-1">{actionError}</div>
                    <button type="button" onClick={() => setActionError(null)} className="opacity-70 hover:opacity-100" aria-label={t('common.close', 'Close')}><X className="h-3.5 w-3.5" /></button>
                </div>
            )}

            <ServerLicenseWarning />
            {confirmDialog}
        </div>
    );
}

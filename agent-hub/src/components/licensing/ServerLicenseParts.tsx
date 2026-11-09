// The rows and notes of ServerLicensePanel that hold no state: the facts of
// the applied licence, the field for a new key and the override semantics.

import { AlertCircle, Loader2 } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingBlock, SettingRow } from '../shared/SettingsList';
import { ALERT_WARNING, INPUT, PRIMARY_BTN, QUIET_BTN } from '../mcpLibrary/ui';

interface LicenceFacts {
    issuer?: string;
    expiresAt?: string | null;
    billingInterval?: string;
}

function fmtDate(s: string | null | undefined) {
    if (!s) return '—';
    try { return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return s; }
}

function daysUntil(s: string | null | undefined) {
    if (!s) return null;
    const ms = new Date(s).getTime() - Date.now();
    if (Number.isNaN(ms)) return null;
    return Math.ceil(ms / 86400000);
}

const VALUE = 'text-[13px] text-[var(--text-secondary)] md:text-right';

/** Issuer, expiry and billing of the applied server-wide licence, one row each. */
export function ServerLicenseFacts({ licence }: { licence: LicenceFacts }) {
    const { t } = useTranslation();
    const expiresAt = licence.expiresAt || null;
    const daysLeft = daysUntil(expiresAt);
    return (
        <>
            <SettingRow label={t('admin.server_license.issuer', 'Issuer')}>
                <div className={`${VALUE} truncate font-mono`}>{licence.issuer || '—'}</div>
            </SettingRow>
            <SettingRow label={t('admin.server_license.expires', 'Expires')}>
                <div className={VALUE}>{fmtDate(expiresAt)} {daysLeft != null && daysLeft >= 0 ? `· ${daysLeft}d` : ''}</div>
            </SettingRow>
            <SettingRow label={t('admin.server_license.billing', 'Billing')}>
                <div className={VALUE}>{licence.billingInterval || '—'}</div>
            </SettingRow>
        </>
    );
}

interface ServerLicenseTokenProps {
    value: string;
    onChange: (value: string) => void;
    busy: 'activate' | 'deactivate' | null;
    onCancel: () => void;
    onActivate: () => void;
}

/** The field a new licence key is pasted into, with Cancel and Activate. */
export function ServerLicenseToken({ value, onChange, busy, onCancel, onActivate }: ServerLicenseTokenProps) {
    const { t } = useTranslation();
    return (
        <SettingBlock label={t('admin.server_license.activate_confirm', 'Activate server-wide')} htmlFor="server-licence-token">
            <textarea
                id="server-licence-token"
                value={value}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
                placeholder={t('admin.server_license.token_placeholder', 'Paste licence JWT or admin blob (beeflow-admin-v1.…)')}
                className={`${INPUT} h-24 font-mono text-xs`}
            />
            <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={onCancel} className={QUIET_BTN} disabled={!!busy}>
                    {t('common.cancel', 'Cancel')}
                </button>
                <button type="button" onClick={onActivate} disabled={!value.trim() || busy === 'activate'} className={PRIMARY_BTN}>
                    {busy === 'activate'
                        ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('admin.server_license.activating', 'Activating…')}</>)
                        : (t('admin.server_license.activate_confirm', 'Activate server-wide'))}
                </button>
            </div>
        </SettingBlock>
    );
}

/** What applying a server-wide licence does to every organisation. */
export function ServerLicenseWarning() {
    const { t } = useTranslation();
    return (
        <div className={ALERT_WARNING}>
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
                <div className="mb-1 font-semibold">
                    {t('admin.server_license.warn_title', 'Override semantics')}
                </div>
                <ul className="m-0 list-disc space-y-0.5 pl-4">
                    <li>{t('admin.server_license.warn_override', 'Every organisation on this install will resolve to the server-wide tier.')}</li>
                    <li>{t('admin.server_license.warn_per_org_hidden', 'Per-organisation activation is disabled in Org Settings while a server-wide licence is active.')}</li>
                    <li>{t('admin.server_license.warn_rollback', 'Per-organisation licences are preserved — deactivating restores them.')}</li>
                    <li>{t('admin.server_license.warn_tier_min', 'Community-tier licences are rejected: Community is the default floor already.')}</li>
                </ul>
            </div>
        </div>
    );
}

import React, { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/utils/helpers';
import { settled } from '@/api/settled';
import type { AuthFetchOptions } from '@/utils/helpers.types';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { CARD, LABEL } from './sso/SsoFormParts';

/** A pending Microsoft identity link request. */
interface LinkRequest {
    id: string;
    email: string;
    tenant_id: string;
    object_id: string;
}

interface SyncBinding {
    syncOrganizationId: string;
    syncTenantId: string;
}

const FIELD = 'w-full px-4 py-2.5 rounded-lg text-sm font-mono bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)]';
const PRIMARY_BUTTON = 'px-5 py-2.5 rounded-lg text-sm font-medium text-white shadow-md bg-[var(--accent-primary)] disabled:opacity-50';
const SECONDARY_BUTTON = 'px-5 py-2.5 rounded-lg text-sm font-medium border border-[var(--border-default)] text-[var(--text-secondary)] bg-[var(--bg-secondary)] disabled:opacity-50';

export default function MicrosoftIdentityPanel() {
    const { t } = useTranslation();
    const [requests, setRequests] = useState<LinkRequest[]>([]);
    const [binding, setBinding] = useState<SyncBinding>({ syncOrganizationId: '', syncTenantId: '' });
    const [users, setUsers] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | undefined>('');
    const [busy, setBusy] = useState(false);
    const request = useCallback(async (path: string, options?: AuthFetchOptions) => {
        const res = await settled(`${API_BASE}/auth/microsoft/${path}`, options);
        if (!res.ok) throw new Error(res.body.error || t('common.error'));
        return await res.res.json();
    }, [t]);
    const refresh = useCallback(async () => {
        try {
            const [pending, current] = await Promise.all([request('link-requests'), request('sync-binding')]);
            setRequests(pending);
            setBinding({ syncOrganizationId: current.syncOrganizationId || '', syncTenantId: current.syncTenantId || '' });
        } catch (err) { setError(errorMessage(err)); }
    }, [request]);
    useEffect(() => { refresh(); }, [refresh]);
    async function act(path: string, method: string, body?: unknown) {
        setBusy(true); setError('');
        try {
            await request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
            await refresh();
        } catch (err) { setError(errorMessage(err)); }
        finally { setBusy(false); }
    }
    return <section className={`${CARD} mt-6 space-y-6`}>
        <div>
            <h3 className="text-lg font-semibold text-primary">{t('azure.identity_admin_title', 'Microsoft identities and directory sync')}</h3>
            <p className="text-sm text-muted">{t('azure.identity_admin_help', 'Verify the person and their tenant before linking an identity. An email match alone is insufficient.')}</p>
        </div>
        {error && <p role="alert" className="p-3 rounded-lg text-sm bg-red-500/10 text-red-400 border border-red-500/20">{error}</p>}

        <div className="space-y-3">
            <h4 className="font-semibold text-primary">{t('azure.identity_requests_title', 'Pending identity links')}</h4>
            {requests.length === 0 && <p className="text-sm text-secondary">{t('azure.identity_requests_empty', 'No pending link requests.')}</p>}
            {requests.map(row => <div key={row.id} className="p-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] space-y-3">
                <p className="text-sm font-mono text-secondary break-all">{row.email} · {row.tenant_id} · {row.object_id}</p>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                    <div className="flex-1">
                        <label htmlFor={`ms-link-${row.id}`} className={LABEL}>{t('azure.identity_local_user', 'Local user ID')}</label>
                        <input id={`ms-link-${row.id}`} className={FIELD} value={users[row.id] || ''} onChange={e => setUsers({ ...users, [row.id]: e.target.value })} />
                    </div>
                    <button type="button" className={PRIMARY_BUTTON} disabled={busy || !users[row.id]?.trim()} onClick={() => act(`users/${encodeURIComponent(users[row.id].trim())}/identity`, 'PUT', { requestId: row.id })}>
                        {t('azure.identity_confirm', 'Confirm identity link')}
                    </button>
                </div>
            </div>)}
        </div>

        <div className="space-y-3">
            <h4 className="font-semibold text-primary">{t('azure.sync_binding_title', 'Directory sync binding')}</h4>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                    <label htmlFor="ms-sync-org" className={LABEL}>{t('azure.sync_target_organization', 'Directory sync organization ID')}</label>
                    <input id="ms-sync-org" className={FIELD} value={binding.syncOrganizationId} onChange={e => setBinding({ ...binding, syncOrganizationId: e.target.value })} />
                </div>
                <div>
                    <label htmlFor="ms-sync-tenant" className={LABEL}>{t('azure.sync_target_tenant', 'Directory sync tenant GUID')}</label>
                    <input id="ms-sync-tenant" className={FIELD} value={binding.syncTenantId} onChange={e => setBinding({ ...binding, syncTenantId: e.target.value })} />
                </div>
            </div>
            <button type="button" className={PRIMARY_BUTTON} disabled={busy || !binding.syncOrganizationId || !binding.syncTenantId} onClick={() => act('sync-binding', 'PUT', binding)}>
                {t('azure.sync_confirm_binding', 'Save directory sync binding')}
            </button>
        </div>

        <MicrosoftUnlink onUnlink={userId => act(`users/${encodeURIComponent(userId)}/identity`, 'DELETE')} busy={busy} />
    </section>;
}
function MicrosoftUnlink({ onUnlink, busy }: { onUnlink: (userId: string) => unknown; busy: boolean }) {
    const { t } = useTranslation();
    const [userId, setUserId] = useState('');
    const [confirm, setConfirm] = useState(false);
    return <div className="space-y-3">
        <h4 className="font-semibold text-primary">{t('azure.identity_disconnect_title', 'Disconnect an identity')}</h4>
        <div className="lg:w-1/2">
            <label htmlFor="ms-unlink-user" className={LABEL}>{t('azure.identity_disconnect_user', 'Disconnect Microsoft identity for local user ID')}</label>
            <input id="ms-unlink-user" className={FIELD} value={userId} onChange={e => { setUserId(e.target.value); setConfirm(false); }} />
        </div>
        <label className="flex items-start gap-2 text-sm text-secondary">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
            <span>{t('azure.identity_disconnect_confirm', 'I confirm this account must stop accepting its current Microsoft identity.')}</span>
        </label>
        <button type="button" className={SECONDARY_BUTTON} disabled={busy || !userId.trim() || !confirm} onClick={() => onUnlink(userId.trim())}>
            {t('azure.identity_disconnect', 'Disconnect identity')}
        </button>
    </div>;
}

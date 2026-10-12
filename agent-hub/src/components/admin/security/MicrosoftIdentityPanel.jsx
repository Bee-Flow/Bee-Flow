import React, { useCallback, useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';

export default function MicrosoftIdentityPanel() {
    const { t } = useTranslation();
    const [requests, setRequests] = useState([]);
    const [binding, setBinding] = useState({ syncOrganizationId: '', syncTenantId: '' });
    const [users, setUsers] = useState({});
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const request = useCallback(async (path, options) => {
        const res = await authFetch(`${API_BASE}/auth/microsoft/${path}`, options);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('common.error'));
        return data;
    }, [t]);
    const refresh = useCallback(async () => {
        try {
            const [pending, current] = await Promise.all([request('link-requests'), request('sync-binding')]);
            setRequests(pending);
            setBinding({ syncOrganizationId: current.syncOrganizationId || '', syncTenantId: current.syncTenantId || '' });
        } catch (err) { setError(err.message); }
    }, [request]);
    useEffect(() => { refresh(); }, [refresh]);
    async function act(path, method, body) {
        setBusy(true); setError('');
        try {
            await request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
            await refresh();
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
    }
    const fieldClass = 'w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm';
    return <section className="mt-6 space-y-4 rounded border border-[var(--border-default)] p-4">
        <h3>{t('azure.identity_admin_title', 'Microsoft identities and directory sync')}</h3>
        <p>{t('azure.identity_admin_help', 'Verify the person and their tenant before linking an identity. An email match alone is insufficient.')}</p>
        {error && <p role="alert">{error}</p>}
        {requests.map(row => <div key={row.id} className="space-y-2 border-b border-[var(--border-default)] pb-3">
            <p>{row.email} · {row.tenant_id} · {row.object_id}</p>
            <label>{t('azure.identity_local_user', 'Local user ID')}
                <input className={fieldClass} value={users[row.id] || ''} onChange={e => setUsers({ ...users, [row.id]: e.target.value })} />
            </label>
            <button type="button" disabled={busy || !users[row.id]?.trim()} onClick={() => act(`users/${encodeURIComponent(users[row.id].trim())}/identity`, 'PUT', { requestId: row.id })}>
                {t('azure.identity_confirm', 'Confirm identity link')}
            </button>
        </div>)}
        <label>{t('azure.sync_target_organization', 'Directory sync organization ID')}
            <input className={fieldClass} value={binding.syncOrganizationId} onChange={e => setBinding({ ...binding, syncOrganizationId: e.target.value })} />
        </label>
        <label>{t('azure.sync_target_tenant', 'Directory sync tenant GUID')}
            <input className={fieldClass} value={binding.syncTenantId} onChange={e => setBinding({ ...binding, syncTenantId: e.target.value })} />
        </label>
        <button type="button" disabled={busy || !binding.syncOrganizationId || !binding.syncTenantId} onClick={() => act('sync-binding', 'PUT', binding)}>
            {t('azure.sync_confirm_binding', 'Save directory sync binding')}
        </button>
        <MicrosoftUnlink onUnlink={userId => act(`users/${encodeURIComponent(userId)}/identity`, 'DELETE')} busy={busy} />
    </section>;
}
function MicrosoftUnlink({ onUnlink, busy }) {
    const { t } = useTranslation();
    const [userId, setUserId] = useState('');
    const [confirm, setConfirm] = useState(false);
    return <div className="space-y-2">
        <label>{t('azure.identity_disconnect_user', 'Disconnect Microsoft identity for local user ID')}
            <input value={userId} onChange={e => { setUserId(e.target.value); setConfirm(false); }} />
        </label>
        <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
            {t('azure.identity_disconnect_confirm', 'I confirm this account must stop accepting its current Microsoft identity.')}
        </label>
        <button type="button" disabled={busy || !userId.trim() || !confirm} onClick={() => onUnlink(userId.trim())}>
            {t('azure.identity_disconnect', 'Disconnect identity')}
        </button>
    </div>;
}

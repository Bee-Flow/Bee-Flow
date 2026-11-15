import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiUrl } from '@/api/typedRequest';
import { settled } from '@/api/settled';
import { useAdminOrganizationsQuery, type AdminOrgOption } from '@/api/queries/adminOrganizations';
import { useAdminUserOptionsQuery, type AdminUserOption } from '@/api/queries/adminUserOptions';
import type { AuthFetchOptions } from '@/utils/helpers.types';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { Button } from '@/components/shared/Button';
import { ALERT_ERROR, HINT, INPUT } from '@/components/shared/adminUi';
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

interface MicrosoftIdentityPanelProps {
    /**
     * The tenant of the Microsoft sign-in configuration, when one is set. The
     * server only accepts a sync binding on that tenant, so an empty binding
     * starts with it filled in.
     */
    ssoTenantId?: string | null;
}

const MICROSOFT_IDENTITY_KEY = ['admin', 'microsoftIdentity'] as const;
const NO_REQUESTS: LinkRequest[] = [];
const MONO_INPUT = `${INPUT} font-mono`;
const H4 = 'text-sm font-semibold text-[var(--text-primary)]';

/** Picks a local account from the server's accounts; a typed id when the list cannot be read. */
function AccountField({ id, label, fallbackLabel, users, value, onChange }: {
    id: string; label: string; fallbackLabel: string; users: readonly AdminUserOption[]; value: string; onChange: (v: string) => void;
}) {
    const { t } = useTranslation();
    if (users.length === 0) {
        return <>
            <label htmlFor={id} className={LABEL}>{fallbackLabel}</label>
            <input id={id} className={MONO_INPUT} value={value} onChange={e => onChange(e.target.value)} />
        </>;
    }
    return <>
        <label htmlFor={id} className={LABEL}>{label}</label>
        <select id={id} className={INPUT} value={value} onChange={e => onChange(e.target.value)}>
            <option value="">{t('admin_people.ms_pick_account_placeholder', 'Choose an account…')}</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.email && u.email !== u.name ? `${u.name} (${u.email})` : u.name}</option>)}
        </select>
    </>;
}

/** Picks the organisation the directory sync fills; a typed id when the list cannot be read. */
function OrganisationField({ organizations, value, onChange }: { organizations: readonly AdminOrgOption[]; value: string; onChange: (v: string) => void }) {
    const { t } = useTranslation();
    // A stored binding on an organisation the list does not hold stays visible (and editable as an id).
    if (organizations.length === 0 || (value !== '' && !organizations.some(o => o.id === value))) {
        return <>
            <label htmlFor="ms-sync-org" className={LABEL}>{t('azure.sync_target_organization', 'Directory sync organization ID')}</label>
            <input id="ms-sync-org" className={MONO_INPUT} value={value} onChange={e => onChange(e.target.value)} />
        </>;
    }
    return <>
        <label htmlFor="ms-sync-org" className={LABEL}>{t('admin_people.ms_sync_organisation', 'Organisation to sync into')}</label>
        <select id="ms-sync-org" className={INPUT} value={value} onChange={e => onChange(e.target.value)}>
            <option value="">{t('admin_people.ms_pick_organisation_placeholder', 'Choose an organisation…')}</option>
            {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
    </>;
}

/** The binding form starts from what the server holds, else from the sign-in tenant. */
function bindingOf(current: Partial<SyncBinding>, ssoTenantId: string | null | undefined): SyncBinding {
    return {
        syncOrganizationId: current.syncOrganizationId || '',
        syncTenantId: current.syncTenantId || ssoTenantId || '',
    };
}

/** The link requests and the stored binding, the binding form, and the actions on them. */
function useMicrosoftIdentity(ssoTenantId: string | null) {
    const { t } = useTranslation();
    const [binding, setBinding] = useState<SyncBinding>({ syncOrganizationId: '', syncTenantId: '' });
    const [error, setError] = useState<string | undefined>('');
    const request = useCallback(async (url: string, options?: AuthFetchOptions) => {
        const res = await settled(url, options);
        if (!res.ok) throw new Error(res.body.error || t('common.error'));
        return await res.res.json();
    }, [t]);
    const queryClient = useQueryClient();
    const query = useQuery<{ pending: LinkRequest[]; current: Partial<SyncBinding> }>({
        queryKey: MICROSOFT_IDENTITY_KEY,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                const [pending, current] = await Promise.all([request(apiUrl('GET /auth/microsoft/link-requests')), request(apiUrl('GET /auth/microsoft/sync-binding'))]);
                return { pending, current };
            } catch (err) { setError(errorMessage(err)); throw err; }
        },
    });
    // Every answer refills the binding form; typing then edits it until the next answer.
    // `seen` starts empty, so an answer already cached when the panel opens fills it too.
    const [seen, setSeen] = useState<typeof query.data>(undefined);
    if (query.data && query.data !== seen) {
        setSeen(query.data);
        setBinding(bindingOf(query.data.current, ssoTenantId));
    }
    const tenantFromSso = !!ssoTenantId && !query.data?.current.syncTenantId && binding.syncTenantId === ssoTenantId;
    const action = useMutation({
        mutationFn: ({ url, method, body }: { url: string; method: string; body?: unknown }) =>
            request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        onMutate: () => setError(''),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: MICROSOFT_IDENTITY_KEY }),
        onError: (err) => setError(errorMessage(err)),
    });
    const act = (url: string, method: string, body?: unknown) => action.mutate({ url, method, body });
    return { requests: query.data?.pending ?? NO_REQUESTS, binding, setBinding, tenantFromSso, error, busy: action.isPending, act };
}

export default function MicrosoftIdentityPanel({ ssoTenantId = null }: MicrosoftIdentityPanelProps) {
    const { t } = useTranslation();
    const [users, setUsers] = useState<Record<string, string>>({});
    const accounts = useAdminUserOptionsQuery().data ?? [];
    const organizations = useAdminOrganizationsQuery(true).data ?? [];
    const { requests, binding, setBinding, tenantFromSso, error, busy, act } = useMicrosoftIdentity(ssoTenantId);
    return <section className={`${CARD} space-y-6`}>
        <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('azure.identity_admin_title', 'Microsoft identities and directory sync')}</h3>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{t('azure.identity_admin_help', 'Verify the person and their tenant before linking an identity. An email match alone is insufficient.')}</p>
        </div>
        {error && <p role="alert" className={ALERT_ERROR}>{error}</p>}

        <div className="space-y-3">
            <h4 className={H4}>{t('azure.identity_requests_title', 'Pending identity links')}</h4>
            {requests.length === 0 && <p className="text-sm text-[var(--text-muted)]">{t('azure.identity_requests_empty', 'No pending link requests.')}</p>}
            {requests.map(row => <div key={row.id} className="p-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] space-y-3">
                <p className="text-sm font-mono text-[var(--text-secondary)] break-all">{row.email} · {row.tenant_id} · {row.object_id}</p>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                    <div className="flex-1">
                        <AccountField
                            id={`ms-link-${row.id}`}
                            label={t('admin_people.ms_link_account', 'Link to account')}
                            fallbackLabel={t('azure.identity_local_user', 'Local user ID')}
                            users={accounts}
                            value={users[row.id] || ''}
                            onChange={v => setUsers({ ...users, [row.id]: v })}
                        />
                    </div>
                    <Button variant="primary" disabled={busy || !users[row.id]?.trim()} onClick={() => act(apiUrl('PUT /auth/microsoft/users/{userId}/identity', { params: { userId: users[row.id].trim() } }), 'PUT', { requestId: row.id })}>
                        {t('azure.identity_confirm', 'Confirm identity link')}
                    </Button>
                </div>
            </div>)}
        </div>

        <div className="space-y-3">
            <h4 className={H4}>{t('azure.sync_binding_title', 'Directory sync binding')}</h4>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                    <OrganisationField organizations={organizations} value={binding.syncOrganizationId} onChange={v => setBinding({ ...binding, syncOrganizationId: v })} />
                </div>
                <div>
                    <label htmlFor="ms-sync-tenant" className={LABEL}>{t('azure.sync_target_tenant', 'Directory sync tenant GUID')}</label>
                    <input id="ms-sync-tenant" className={MONO_INPUT} value={binding.syncTenantId} onChange={e => setBinding({ ...binding, syncTenantId: e.target.value })} />
                    {tenantFromSso && <p className={HINT}>{t('admin_people.ms_tenant_from_sso', 'Filled in from the Microsoft sign-in settings. The sync must use the same tenant.')}</p>}
                </div>
            </div>
            <Button variant="primary" disabled={busy || !binding.syncOrganizationId || !binding.syncTenantId} onClick={() => act(apiUrl('PUT /auth/microsoft/sync-binding'), 'PUT', binding)}>
                {t('azure.sync_confirm_binding', 'Save directory sync binding')}
            </Button>
        </div>

        <MicrosoftUnlink accounts={accounts} onUnlink={userId => act(apiUrl('DELETE /auth/microsoft/users/{userId}/identity', { params: { userId } }), 'DELETE')} busy={busy} />
    </section>;
}

function MicrosoftUnlink({ accounts, onUnlink, busy }: { accounts: readonly AdminUserOption[]; onUnlink: (userId: string) => unknown; busy: boolean }) {
    const { t } = useTranslation();
    const [userId, setUserId] = useState('');
    const [confirm, setConfirm] = useState(false);
    return <div className="space-y-3">
        <h4 className={H4}>{t('azure.identity_disconnect_title', 'Disconnect an identity')}</h4>
        <div className="lg:w-1/2">
            <AccountField
                id="ms-unlink-user"
                label={t('admin_people.ms_unlink_account', 'Account to disconnect')}
                fallbackLabel={t('azure.identity_disconnect_user', 'Disconnect Microsoft identity for local user ID')}
                users={accounts}
                value={userId}
                onChange={v => { setUserId(v); setConfirm(false); }}
            />
        </div>
        <label className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
            <input type="checkbox" className="mt-1 accent-[var(--accent-primary)]" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
            <span>{t('azure.identity_disconnect_confirm', 'I confirm this account must stop accepting its current Microsoft identity.')}</span>
        </label>
        <Button variant="danger" disabled={busy || !userId.trim() || !confirm} onClick={() => onUnlink(userId.trim())}>
            {t('azure.identity_disconnect', 'Disconnect identity')}
        </Button>
    </div>;
}

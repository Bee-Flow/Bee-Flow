import { KeyRound, Plus, Upload } from 'lucide-react';
import { useState } from 'react';
import { GrantWizard } from './GrantWizard';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import EmptyState from '@/components/shared/EmptyState';
import { toast } from '@/components/shared/Toast';
import { TIER_PRESETS } from '../constants';
import { useResource, apiJson } from '../hooks/useApi';
import { GrantsTable, type Grant } from './GrantsTable';
import { ConfirmModal } from '../ui/Modal';
import SectionHeader from '@/components/shared/SectionHeader';
import Spinner from '@/components/shared/Spinner';

/** What the wizard offers as an organization. */
interface GrantOrg {
    id: string;
    name: string;
}

/** An organization row of GET /auth/organizations. */
interface OrgRow {
    id: string;
    name?: string;
}

export function GrantsView() {
    const { t } = useTranslation();
    const orgsRes  = useResource<GrantOrg[], OrgRow[] | { organizations?: OrgRow[]; orgs?: OrgRow[] }>('/auth/organizations', { initial: [], transform: data => {
        const list = Array.isArray(data) ? data : (data.organizations || data.orgs || []);
        return list.map(o => ({ id: o.id, name: o.name || o.id })).filter(o => o.id);
    }});
    const capsRes  = useResource<{ tiers: string[] }>('/api/admin/licenses/capabilities', {
        initial: { tiers: TIER_PRESETS },
    });
    const listRes  = useResource<{ licenses: Grant[] }, { licenses?: Grant[] }>('/api/admin/licenses?includeInactive=true', {
        initial: { licenses: [] },
        transform: j => ({ licenses: j.licenses || [] }),
    });

    const [issuing, setIssuing]   = useState(false);
    const [revoking, setRevoking] = useState<Grant | null>(null);
    const [busy, setBusy]         = useState(false);

    const grants = listRes.data?.licenses || [];
    const orgs   = orgsRes.data || [];
    const tiers  = capsRes.data?.tiers || TIER_PRESETS;

    const copyBlob = async (blob: string) => {
        try { await navigator.clipboard.writeText(blob); toast.success(t('admin_subscriptions.grants_blob_copied', 'Blob copied.')); }
        catch { window.prompt(t('admin_subscriptions.grants_copy_prompt', 'Copy this blob:'), blob); }
    };

    const handleExtend = async (id: string, current: string | number | Date | undefined) => {
        const def = current ? new Date(current).toISOString().slice(0, 10) : '';
        const next = window.prompt(t('admin_subscriptions.grants_expiry_prompt', 'New expiry date (YYYY-MM-DD):'), def);
        if (!next) return;
        try {
            await apiJson(`/api/admin/licenses/${id}/extend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expiresAt: new Date(next + 'T23:59:59Z').toISOString() }),
            });
            toast.success(t('admin_subscriptions.grants_expiry_extended', 'Expiry extended.'));
            listRes.reload();
        } catch (e) { toast.error((e as Error).message || t('admin_subscriptions.grants_extend_failed', 'Extend failed')); }
    };

    const handleRevoke = async () => {
        if (!revoking) return;
        setBusy(true);
        try {
            await apiJson(`/api/admin/licenses/${revoking.id}/revoke`, { method: 'POST' });
            toast.success(t('admin_subscriptions.grants_revoked', 'License revoked.'));
            setRevoking(null);
            listRes.reload();
        } catch (e) { toast.error((e as Error).message || t('admin_subscriptions.grants_revoke_failed', 'Revoke failed')); }
        finally { setBusy(false); }
    };

    const handleImport = async () => {
        const blob = window.prompt(t('admin_subscriptions.grants_import_prompt', 'Paste a beeflow-admin-v1.* license blob to import:'));
        if (!blob) return;
        const orgId = window.prompt(t('admin_subscriptions.grants_import_org_prompt', 'Target organization id (leave blank to use the org embedded in the blob):'), '');
        try {
            await apiJson('/api/admin/licenses/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blob: blob.trim(), organizationId: orgId || null }),
            });
            toast.success(t('admin_subscriptions.grants_imported', 'License imported.'));
            listRes.reload();
        } catch (e) { toast.error((e as Error).message || t('admin_subscriptions.grants_import_failed', 'Import failed')); }
    };

    if (issuing) {
        return (
            <GrantWizard
                orgs={orgs}
                tiers={tiers}
                onBack={() => setIssuing(false)}
                onCreated={() => { setIssuing(false); listRes.reload(); }}
            />
        );
    }

    const loading = orgsRes.loading || capsRes.loading || listRes.loading;

    return (
        <div className="p-6 md:p-8">
            <SectionHeader className="mb-5"
                title={t('admin_subscriptions.grants_title', 'Admin License Grants')}
                description={t('admin_subscriptions.grants_desc', 'Mint licenses directly without Stripe. Org members pick up the new tier on next request.')}
                status={
                    <div className="flex items-center gap-2">
                        <Button variant="secondary" icon={Upload} onClick={handleImport}>{t('admin_subscriptions.grants_import', 'Import blob')}</Button>
                        <Button icon={Plus} onClick={() => setIssuing(true)}>{t('admin_subscriptions.grants_issue', 'Issue license')}</Button>
                    </div>
                }
            />

            {loading ? (
                <div className="flex justify-center py-12"><Spinner label={t('admin_subscriptions.grants_loading', 'Loading grants…')} /></div>
            ) : grants.length === 0 ? (
                <EmptyState
                    icon={<KeyRound className="w-6 h-6" />}
                    title={t('admin_subscriptions.grants_empty', 'No admin grants yet')}
                    description={t('admin_subscriptions.grants_empty_desc', 'Issue your first license to an organization.')}
                    action={<Button icon={Plus} onClick={() => setIssuing(true)}>{t('admin_subscriptions.grants_issue', 'Issue license')}</Button>}
                />
            ) : (
                <GrantsTable grants={grants} onCopy={copyBlob} onExtend={handleExtend} onRevoke={setRevoking} />
            )}

            <ConfirmModal
                open={!!revoking}
                onClose={() => setRevoking(null)}
                onConfirm={handleRevoke}
                busy={busy}
                title={t('admin_subscriptions.grants_revoke_title', 'Revoke license?')}
                message={t('admin_subscriptions.grants_revoke_message', 'Members of the organization will fall back to community tier on their next request. This cannot be undone.')}
                confirmLabel={t('admin_subscriptions.grants_revoke_confirm', 'Revoke license')}
            />
        </div>
    );
}

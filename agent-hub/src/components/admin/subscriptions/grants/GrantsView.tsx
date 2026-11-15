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
import { CopyBlobDialog, ExtendDialog, ImportDialog } from './GrantDialogs';
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
    const [copyFallback, setCopyFallback] = useState<string | null>(null);
    const [extending, setExtending] = useState<{ id: string; expiresAt?: string | number | Date } | null>(null);
    const [importing, setImporting] = useState(false);

    const grants = listRes.data?.licenses || [];
    const orgs   = orgsRes.data || [];
    const tiers  = capsRes.data?.tiers || TIER_PRESETS;

    const copyBlob = async (blob: string) => {
        try { await navigator.clipboard.writeText(blob); toast.success(t('admin_subscriptions.grants_blob_copied', 'Blob copied.')); }
        catch { setCopyFallback(blob); }
    };

    const handleExtend = async (date: string) => {
        if (!extending) return;
        setBusy(true);
        try {
            await apiJson(`/api/admin/licenses/${extending.id}/extend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expiresAt: new Date(date + 'T23:59:59Z').toISOString() }),
            });
            toast.success(t('admin_subscriptions.grants_expiry_extended', 'Expiry extended.'));
            setExtending(null);
            listRes.reload();
        } catch (e) { toast.error((e as Error).message || t('admin_subscriptions.grants_extend_failed', 'Extend failed')); }
        finally { setBusy(false); }
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

    const handleImport = async (blob: string, organizationId: string | null) => {
        setBusy(true);
        try {
            await apiJson('/api/admin/licenses/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blob, organizationId }),
            });
            toast.success(t('admin_subscriptions.grants_imported', 'License imported.'));
            setImporting(false);
            listRes.reload();
        } catch (e) { toast.error((e as Error).message || t('admin_subscriptions.grants_import_failed', 'Import failed')); }
        finally { setBusy(false); }
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
                        <Button variant="secondary" icon={Upload} onClick={() => setImporting(true)}>{t('admin_subscriptions.grants_import', 'Import blob')}</Button>
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
                <GrantsTable grants={grants} onCopy={copyBlob} onExtend={(id, expiresAt) => setExtending({ id, expiresAt })} onRevoke={setRevoking} />
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
            <CopyBlobDialog blob={copyFallback} onClose={() => setCopyFallback(null)} />
            <ExtendDialog grant={extending} busy={busy} onClose={() => setExtending(null)} onSave={handleExtend} />
            <ImportDialog open={importing} orgs={orgs} busy={busy} onClose={() => setImporting(false)} onImport={handleImport} />
        </div>
    );
}

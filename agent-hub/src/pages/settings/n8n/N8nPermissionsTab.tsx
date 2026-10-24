import { Crown, ExternalLink, Info, Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { settingsPathForTab } from '../../../authedApp/settingsRoutes';
import { useTranslation, type TranslateFn } from '../../../hooks/useTranslation';
import type { N8nGroup, PermissionSummary } from './n8nModel';

interface Bucket {
    id: string;
    title: string;
    desc: string;
    groups: N8nGroup[];
}

const userCountLabel = (t: TranslateFn, n: number | undefined) =>
    n === 1 ? t('settings.n8n.user_one', '1 user') : t('settings.n8n.user_many', '{count} users', { count: n });

const PICKER_STYLE = { borderColor: 'var(--border-default)', color: 'var(--text-primary)', background: 'var(--bg-primary)' };

/** Inline "New group name… / Create & grant / Cancel". */
function CreateGroupRow({ onCreate, onCancel }: { onCreate: (name: string) => Promise<boolean>; onCancel: () => void }) {
    const { t } = useTranslation();
    const [newGroupName, setNewGroupName] = useState('');
    const [creating, setCreating] = useState(false);
    const close = () => { onCancel(); setNewGroupName(''); };
    const handleCreate = async () => {
        setCreating(true);
        try {
            if (await onCreate(newGroupName)) close();
        } finally { setCreating(false); }
    };
    return (
        <div className="flex items-center gap-2 flex-1">
            <input
                type="text"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !creating) handleCreate(); if (e.key === 'Escape') close(); }}
                autoFocus
                placeholder={t('settings.n8n.new_group_placeholder', 'New group name…')}
                disabled={creating}
                className="flex-1 px-2 py-1 text-xs rounded border bg-transparent outline-none focus:border-[var(--accent-primary)] disabled:opacity-50"
                style={PICKER_STYLE}
            />
            <button
                onClick={handleCreate}
                disabled={creating || !newGroupName.trim()}
                className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all disabled:opacity-50 [background:var(--accent-primary)] [color:white]!"
            >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('settings.n8n.create_grant', 'Create & grant')}
            </button>
            <button onClick={close} disabled={creating} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]" title={t('settings.n8n.cancel', 'Cancel')}>
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}

/** A select of the groups that do not hold the permission yet. */
function GroupPicker({ addable, onPick, onCancel }: { addable: N8nGroup[]; onPick: (groupId: string) => void; onCancel: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 flex-1">
            <select
                onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
                defaultValue=""
                autoFocus
                className="flex-1 px-2 py-1 text-xs rounded border bg-transparent outline-none focus:border-[var(--accent-primary)]"
                style={PICKER_STYLE}
            >
                <option value="" disabled>{t('settings.n8n.select_group', 'Select a group to grant…')}</option>
                {addable.map(g => (
                    <option key={g.id} value={g.id}>
                        {g.name} ({userCountLabel(t, g.userCount)}){g.isGlobal ? ' — ' + t('settings.n8n.global', 'global') : ''}
                    </option>
                ))}
            </select>
            <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]" title={t('settings.n8n.cancel', 'Cancel')}>
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}

interface BucketProps {
    bucket: Bucket;
    availableGroups: N8nGroup[];
    orgAdminAlways: boolean;
    onAdd: (groupId: string) => Promise<boolean>;
    onRemove: (groupId: string) => Promise<boolean>;
    onCreateAndGrant: (name: string) => Promise<boolean>;
}

/** Add-group / create-group row under a bucket. */
function BucketActions({ addable, availableGroups, onAddGroup, onCreateAndGrant }: {
    addable: N8nGroup[];
    availableGroups: N8nGroup[];
    onAddGroup: (groupId: string) => void;
    onCreateAndGrant: (name: string) => Promise<boolean>;
}) {
    const { t } = useTranslation();
    const [pickerOpen, setPickerOpen] = useState(false);
    const [creatingOpen, setCreatingOpen] = useState(false);
    if (creatingOpen) return <CreateGroupRow onCreate={onCreateAndGrant} onCancel={() => setCreatingOpen(false)} />;
    if (pickerOpen) return <GroupPicker addable={addable} onPick={(id) => { setPickerOpen(false); onAddGroup(id); }} onCancel={() => setPickerOpen(false)} />;
    return (
        <>
            {addable.length > 0 && (
                <button onClick={() => setPickerOpen(true)} className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg hover:opacity-80 text-[var(--accent-primary)]">
                    <Plus className="w-3.5 h-3.5" /> {t('settings.n8n.add_existing_group', 'Add existing group')}
                </button>
            )}
            <button onClick={() => setCreatingOpen(true)} className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg hover:opacity-80 text-[var(--accent-primary)]">
                <Plus className="w-3.5 h-3.5" /> {t('settings.n8n.create_new_group', 'Create new group')}
            </button>
            {addable.length === 0 && availableGroups.length > 0 && (
                <span className="text-[11px] ml-auto text-[var(--text-muted)]">
                    {t('settings.n8n.all_hold', 'All existing groups already hold this permission.')}
                </span>
            )}
        </>
    );
}

/** The always-on row for organisation admins. */
function OrgAdminRow() {
    const { t } = useTranslation();
    return (
        <li className="px-3 py-2 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
                <Crown className="w-3.5 h-3.5" style={{ color: '#f59e0b' }} />
                {t('settings.n8n.org_admins', 'Organisation Admins')}
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium [background:rgba(245,158,11,0.12)] [color:#f59e0b]!">
                    {t('settings.n8n.always', 'always')}
                </span>
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">{t('settings.n8n.baked_in', 'baked in')}</span>
        </li>
    );
}

/** One permission with the groups that hold it, revoke buttons and the add row. */
function PermissionBucket({ bucket, availableGroups, orgAdminAlways, onAdd, onRemove, onCreateAndGrant }: BucketProps) {
    const { t } = useTranslation();
    const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
    const heldIds = new Set((bucket.groups || []).map(g => g.id));
    const addable = availableGroups.filter(g => !heldIds.has(g.id));
    const totalCount = (bucket.groups?.length || 0) + (orgAdminAlways ? 1 : 0);
    const withBusy = async (groupId: string, run: (id: string) => Promise<boolean>) => {
        setBusyGroupId(groupId);
        try { await run(groupId); } finally { setBusyGroupId(null); }
    };
    return (
        <div className="rounded-lg border overflow-hidden border-[var(--border-subtle)]">
            <div className="px-3 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--text-primary)]">{bucket.title}</div>
                        <div className="text-[11px] mt-0.5 text-[var(--text-muted)]">{bucket.desc}</div>
                    </div>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        {totalCount === 1 ? t('settings.n8n.grantee_one', '1 grantee') : t('settings.n8n.grantee_many', '{count} grantees', { count: totalCount })}
                    </span>
                </div>
            </div>
            <ul className="divide-y border-[var(--border-subtle)]">
                {orgAdminAlways && <OrgAdminRow />}
                {bucket.groups.length === 0 && !orgAdminAlways && (
                    <li className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
                        {t('settings.n8n.no_groups', 'No groups currently hold this permission.')}
                    </li>
                )}
                {bucket.groups.map(g => (
                    <li key={g.id} className="px-3 py-2 flex items-center justify-between text-xs gap-2">
                        <span className="truncate text-[var(--text-primary)]">{g.name}</span>
                        <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[var(--text-muted)]">{userCountLabel(t, g.userCount)}</span>
                            <button
                                onClick={() => withBusy(g.id, onRemove)}
                                disabled={busyGroupId === g.id}
                                className="p-1 rounded hover:bg-red-500/10 disabled:opacity-50 text-[var(--text-muted)]"
                                title={t('settings.n8n.revoke', 'Revoke permission')}
                            >
                                {busyGroupId === g.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
            <div className="px-3 py-2 border-t flex items-center flex-wrap gap-2 border-[var(--border-subtle)]">
                <BucketActions addable={addable} availableGroups={availableGroups} onAddGroup={(id) => withBusy(id, onAdd)} onCreateAndGrant={onCreateAndGrant} />
            </div>
        </div>
    );
}

interface PermissionsTabProps {
    loading: boolean;
    summary: PermissionSummary | null;
    onReload: () => void;
    onMutate: (permission: string, groupId: string, action: 'add' | 'remove') => Promise<boolean>;
    onCreateAndGrant: (name: string, permission: string) => Promise<boolean>;
}

/** Permissions tab (editable: add/remove groups). */
export default function N8nPermissionsTab({ loading, summary, onReload, onMutate, onCreateAndGrant }: PermissionsTabProps) {
    const { t } = useTranslation();
    if (loading) {
        return (
            <div className="flex items-center justify-center py-6 text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t('settings.n8n.loading_permissions', 'Loading permissions...')}
            </div>
        );
    }
    if (!summary || summary.error) {
        return (
            <div className="rounded-lg border px-4 py-6 text-center border-[var(--border-subtle)] text-[var(--text-muted)]">
                <p className="text-sm mb-2">{summary?.error || t('settings.n8n.load_permissions_failed', 'Could not load permissions')}</p>
                <button onClick={onReload} className="text-xs px-3 py-1 rounded-lg border border-[var(--border-default)] text-[var(--text-primary)]">{t('settings.n8n.retry', 'Retry')}</button>
            </div>
        );
    }
    // The server's editUrl used to be a bare /settings path, which the app
    // does not route; only an /app address is followed, else the canonical one.
    const usersHref = typeof summary.editUrl === 'string' && summary.editUrl.startsWith('/app/')
        ? summary.editUrl
        : settingsPathForTab('org_users');
    // Only the modify bucket — use_n8n_tools is implicit (auto-on for every
    // member when the org has n8n configured).
    const buckets: Bucket[] = [{
        id: 'modify_n8n_workflows',
        title: t('settings.n8n.bucket_modify_title', 'Modify n8n Workflows'),
        desc: t('settings.n8n.bucket_modify_desc', 'Allow the AI to create, edit, delete, activate, and execute workflows on behalf of the user. Organisation admins have this by default — use this panel to grant the same capability to other groups.'),
        groups: summary.modify_n8n_workflows || [],
    }];
    return (
        <div className="space-y-3">
            <div className="rounded-lg border px-3 py-2.5 text-[11px] flex items-start gap-2 border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                    {t('settings.n8n.perm_intro', 'Running n8n workflows from chat works for every member automatically once n8n is configured. The panel below controls')} <b>{t('settings.n8n.perm_modify', 'modify')}</b> {t('settings.n8n.perm_intro_after', 'access — who can let the AI create, edit, delete, or execute workflows. Alternative: use the full group editor in')}{' '}
                    <a href={usersHref} className="underline font-medium inline-flex items-center gap-0.5 text-[var(--accent-primary)]">
                        {t('settings.n8n.users_groups', 'Users & Groups')} <ExternalLink className="w-3 h-3" />
                    </a>.
                </span>
            </div>
            {buckets.map(bucket => (
                <PermissionBucket
                    key={bucket.id}
                    bucket={bucket}
                    availableGroups={summary.availableGroups || []}
                    orgAdminAlways={!!summary.orgAdminAlways}
                    onAdd={(groupId) => onMutate(bucket.id, groupId, 'add')}
                    onRemove={(groupId) => onMutate(bucket.id, groupId, 'remove')}
                    onCreateAndGrant={(name) => onCreateAndGrant(name, bucket.id)}
                />
            ))}
        </div>
    );
}

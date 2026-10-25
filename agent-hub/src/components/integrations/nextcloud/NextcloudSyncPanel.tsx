import { useState, useEffect, useCallback } from 'react';
import { Cloud, RefreshCw, Users, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { TranslateParams, useTranslation } from '../../../hooks/useTranslation';
import { mutate, ApiError } from '../../../api/mutate';

// Theme tokens only, so every card, pill and control stays readable in the
// dark themes (Tailwind 4 draws a bare `border` in currentColor).
const SECTION = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4';
const SECTION_TITLE = 'font-medium text-[var(--text-primary)]';
const STAT_CARD = 'rounded-xl px-3 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]';
const STAT_LABEL = 'text-[10px] font-semibold uppercase tracking-wider mb-0.5 text-[var(--text-muted)]';
const statusPill = (status: string) => (
    status === 'active' ? 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]'
        : status === 'pending' ? 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]'
            : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
);

/**
 * Org-admin UI for Nextcloud user/group sync.
 *
 * The org is auto-bound to a NC instance during connector bootstrap. This
 * panel lets the admin pick the sync mode, exclude specific NC groups,
 * and force an on-demand re-sync.
 */
interface NcSyncConfig {
    mode?: string;
    syncGroups?: string[];
    excludedGroups?: string[];
    newUserDefaultStatus?: string;
    ncBaseUrl?: string;
    lastSyncAt?: string;
}

interface NcSyncUser {
    id: string;
    displayName?: string;
    email?: string;
    status: string;
}

interface NextcloudSyncPanelProps {
    user?: { organizationId?: string | null } | null;
}

const NextcloudSyncPanel = ({ user }: NextcloudSyncPanelProps) => {
    const { t } = useTranslation();
    // The user prop may be a stale snapshot from initial App mount. If we
    // can't see an org id on it, re-fetch /auth/user once before deciding
    // to show "no org" — the connector flow auto-provisions on first hit.
    const [orgId, setOrgId] = useState(user?.organizationId || null);
    useEffect(() => {
        if (orgId) return;
        let cancelled = false;
        authFetch(`${API_BASE}/auth/user`).then(r => r.ok ? r.json() : null).then(j => {
            if (cancelled) return;
            const fresh = j?.user?.organizationId;
            if (fresh) setOrgId(fresh);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [orgId]);
    const [config, setConfig] = useState<NcSyncConfig | null>(null);
    const [groups, setGroups] = useState<string[]>([]);
    const [users, setUsers] = useState<NcSyncUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [message, setMessage] = useState<{ type: string; text: string; } | null>(null);

    const load = useCallback(async () => {
        if (!orgId) return;
        try {
            const [cfgRes, grpRes, usersRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync`),
                authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync/groups`),
                authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync/users`),
            ]);
            if (cfgRes.ok) setConfig(await cfgRes.json());
            if (grpRes.ok) setGroups((await grpRes.json()).groups || []);
            if (usersRes.ok) setUsers((await usersRes.json()).users || []);
        } catch (err) {
            console.error('[NcSync] load:', err);
        } finally { setLoading(false); }
    }, [orgId]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (message) {
            const t = setTimeout(() => setMessage(null), 4000);
            return () => clearTimeout(t);
        }
    }, [message]);

    const update = (patch: Partial<NcSyncConfig>) => setConfig(c => ({ ...c, ...patch }));
    const toggleGroup = (key: 'syncGroups' | 'excludedGroups', group: string) => {
        const list = (config as NcSyncConfig)[key] || [];
        const next = list.includes(group) ? list.filter((g: string) => g !== group) : [...list, group];
        update({ [key]: next });
    };

    const handleSave = async () => {
        if (!config) return;
        setSaving(true);
        try {
            try {
                await mutate(`${API_BASE}/auth/admin/${orgId}/nc-sync`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: config.mode,
                    syncGroups: config.syncGroups,
                    excludedGroups: config.excludedGroups,
                    newUserDefaultStatus: config.newUserDefaultStatus,
                }),
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error('Save failed');
            }
            setMessage({ type: 'ok', text: 'Settings saved' });
        } catch (e) {
            setMessage({ type: 'error', text: (e as Error).message });
        } finally { setSaving(false); }
    };

    const handleSyncNow = async () => {
        setSyncing(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync/run`, { method: 'POST' });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || 'Sync failed');
            setMessage({ type: 'ok', text: `Sync done: created ${j.created || 0}, deactivated ${j.deactivated || 0}` });
            await load();
        } catch (e) {
            setMessage({ type: 'error', text: (e as Error).message });
        } finally { setSyncing(false); }
    };

    if (loading) return <div><Loader2 className="animate-spin text-[var(--text-muted)]" /></div>;
    if (!config) return <div className="text-sm text-[var(--text-muted)]">{t('integ.nextcloud_sync_nextcloud_sync_is_only_available_for', 'Nextcloud sync is only available for organisations bound to a Nextcloud instance.')}</div>;

    // Format relative timestamp for "Last sync" — < 1 min ago, 30 min ago,
    // 4 hr ago, 2 days ago, etc. Falls back to absolute date if older than 7d.
    const formatLastSync = (iso: string | number | Date | undefined) => {
        if (!iso) return 'never';
        const ms = Date.now() - new Date(iso).getTime();
        if (ms < 60_000) return 'just now';
        if (ms < 3600_000) return `${Math.floor(ms / 60_000)} min ago`;
        if (ms < 86400_000) return `${Math.floor(ms / 3600_000)} hr ago`;
        if (ms < 7 * 86400_000) return `${Math.floor(ms / 86400_000)} d ago`;
        return new Date(iso).toLocaleDateString();
    };
    const modeLabel = ({ mirror_all: 'Mirror everything', selective_groups: 'Selective groups', manual: 'Manual only' } as Record<string, string>)[config.mode as string] || config.mode;
    const activeUsers = users.filter(u => u.status === 'active').length;
    const isFresh = config.lastSyncAt && (Date.now() - new Date(config.lastSyncAt).getTime() < 30 * 60_000);

    return (
        <div className="space-y-6 max-w-3xl">
            <header className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Cloud className="w-5 h-5 [color:#0082C9]" />
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('integ.nextcloud_sync_nextcloud_sync', 'Nextcloud Sync')}</h2>
                </div>
                <button onClick={handleSyncNow} disabled={syncing || config.mode === 'manual'}
                    title={config.mode === 'manual' ? 'Sync mode is set to Manual — change to mirror or selective to enable.' : 'Run a full diff sync now'}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg disabled:opacity-50 transition-opacity bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">
                    {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    {t('integ.nextcloud_sync_sync_now', 'Sync now')}
                </button>
            </header>

            {/* Connection-health stat row — at-a-glance status of the NC binding. */}
            <NextcloudSyncPanelSection t={t} config={config} modeLabel={modeLabel} activeUsers={activeUsers} users={users} isFresh={isFresh} formatLastSync={formatLastSync} />

            <NextcloudSyncPanelSection2 t={t} config={config} update={update} />

            <section className={`${SECTION} space-y-3`}>
                <h3 className={SECTION_TITLE}>{t('integ.nextcloud_sync_new_user_default_status', 'New user default status')}</h3>
                <select value={config.newUserDefaultStatus} onChange={e => update({ newUserDefaultStatus: e.target.value })}
                    className="rounded-lg border px-2 py-1 text-sm outline-none bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]">
                    <option value="active">{t('integ.nextcloud_sync_active_immediately_recommended', 'Active immediately (recommended)')}</option>
                    <option value="pending">{t('integ.nextcloud_sync_pending_admin_must_approve', 'Pending — admin must approve')}</option>
                </select>
            </section>

            {config.mode === 'selective_groups' && (
                <section className={`${SECTION} space-y-2`}>
                    <h3 className={SECTION_TITLE}>{t('integ.nextcloud_sync_groups_to_mirror', 'Groups to mirror')}</h3>
                    <p className="text-xs text-[var(--text-muted)]">{t('integ.nextcloud_sync_only_members_of_these_nc_groups_are', 'Only members of these NC groups are synced.')}</p>
                    <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                        {groups.map(g => (
                            <label key={g} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                                <input type="checkbox" checked={config.syncGroups?.includes(g)}
                                    onChange={() => toggleGroup('syncGroups', g)} />
                                {g}
                            </label>
                        ))}
                    </div>
                </section>
            )}

            <section className={`${SECTION} space-y-2`}>
                <h3 className={SECTION_TITLE}>{t('integ.nextcloud_sync_excluded_groups', 'Excluded groups')}</h3>
                <p className="text-xs text-[var(--text-muted)]">{t('integ.nextcloud_sync_members_of_these_nc_groups_are_never', 'Members of these NC groups are NEVER mirrored, even under "mirror everything".')}</p>
                <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                    {groups.map(g => (
                        <label key={g} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                            <input type="checkbox" checked={config.excludedGroups?.includes(g)}
                                onChange={() => toggleGroup('excludedGroups', g)} />
                            {g}
                        </label>
                    ))}
                </div>
            </section>

            <section className={SECTION}>
                <h3 className={`${SECTION_TITLE} flex items-center gap-2`}><Users className="w-4 h-4" /> {t('integ.nextcloud_sync_synced_users_count', 'Synced users ({count})', { count: users.length })}</h3>
                <ul className="text-sm mt-2 max-h-48 overflow-y-auto divide-y divide-[var(--border-subtle)] text-[var(--text-primary)]">
                    {users.map(u => (
                        <li key={u.id} className="py-1.5 flex items-center justify-between">
                            <span>{u.displayName} <span className="text-[var(--text-muted)]">({u.email})</span></span>
                            <span className={`text-xs px-2 py-0.5 rounded ${statusPill(u.status)}`}>{u.status}</span>
                        </li>
                    ))}
                </ul>
            </section>

            <div className="flex items-center gap-3">
                <button onClick={handleSave} disabled={saving}
                    className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">
                    {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                </button>
                {message && (
                    <span className={`text-sm flex items-center gap-1 ${message.type === 'error' ? 'text-[var(--error-ink)]' : 'text-[var(--success-ink)]'}`}>
                        {message.type === 'error' ? <AlertTriangle className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                        {message.text}
                    </span>
                )}
            </div>
        </div>
    );
};

export default NextcloudSyncPanel;

function NextcloudSyncPanelSection2({ t, config, update }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; config: NcSyncConfig; update: (patch: Partial<NcSyncConfig>) => void; }) {
    return <section className={`${SECTION} space-y-3`}>
        <h3 className={SECTION_TITLE}>{t('integ.nextcloud_sync_sync_mode', 'Sync mode')}</h3>
        {[
            { v: 'mirror_all', t: 'Mirror everything', d: 'Every Nextcloud user is automatically created in Bee Flow.' },
            { v: 'selective_groups', t: 'Selective groups', d: 'Only users in the chosen NC groups are mirrored.' },
            { v: 'manual', t: 'Manual only', d: 'New NC users are not auto-created — invite manually.' },
        ].map(opt => (
            <label key={opt.v} className="flex items-start gap-2">
                <input type="radio" name="mode" value={opt.v} checked={config.mode === opt.v}
                    onChange={() => update({ mode: opt.v })} className="mt-1" />
                <div>
                    <div className="text-sm font-medium text-[var(--text-primary)]">{opt.t}</div>
                    <div className="text-xs text-[var(--text-muted)]">{opt.d}</div>
                </div>
            </label>
        ))}
    </section>;
}

function NextcloudSyncPanelSection({ t, config, modeLabel, activeUsers, users, isFresh, formatLastSync }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; config: NcSyncConfig; modeLabel: string | undefined; activeUsers: number; users: NcSyncUser[]; isFresh: string | boolean | undefined; formatLastSync: (iso: string | number | Date | undefined) => string; }) {
    return <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className={STAT_CARD}>
            <div className={STAT_LABEL}>{t('integ.nextcloud_sync_instance', 'Instance')}</div>
            <div className="text-[12px] font-medium truncate text-[var(--text-primary)]" title={config.ncBaseUrl}>
                {config.ncBaseUrl ? config.ncBaseUrl.replace(/^https?:\/\//, '') : '—'}
            </div>
        </div>
        <div className={STAT_CARD}>
            <div className={STAT_LABEL}>{t('integ.nextcloud_sync_sync_mode', 'Sync mode')}</div>
            <div className="text-[12px] font-medium text-[var(--text-primary)]">{modeLabel}</div>
        </div>
        <div className={STAT_CARD}>
            <div className={STAT_LABEL}>{t('integ.nextcloud_sync_active_users', 'Active users')}</div>
            <div className="text-[12px] font-medium text-[var(--text-primary)]">{activeUsers} <span className="opacity-60 font-normal">/ {users.length}</span></div>
        </div>
        <div className={STAT_CARD}>
            <div className={STAT_LABEL}>{t('integ.nextcloud_sync_last_sync', 'Last sync')}</div>
            <div className="text-[12px] font-medium flex items-center gap-1.5 text-[var(--text-primary)]">
                <span className={`w-1.5 h-1.5 rounded-full ${isFresh ? 'bg-[var(--success)]' : config.lastSyncAt ? 'bg-[var(--warning)]' : 'bg-[var(--text-muted)]'}`} />
                {formatLastSync(config.lastSyncAt)}
            </div>
        </div>
    </div>;
}

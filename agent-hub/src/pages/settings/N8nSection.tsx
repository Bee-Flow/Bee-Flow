import { Link2, Loader2, ShieldCheck, Workflow } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import Tabs from '../../components/shared/Tabs';
import { useTranslation } from '../../hooks/useTranslation';
import N8nConnectionTab from './n8n/N8nConnectionTab';
import N8nPermissionsTab from './n8n/N8nPermissionsTab';
import { StatusPill } from './n8n/N8nStatus';
import N8nWorkflowsTab from './n8n/N8nWorkflowsTab';
import { useFlashMessage, useN8nConnection, useN8nPermissions, useN8nWorkflows } from './n8n/useN8nState';

type N8nTab = 'connection' | 'workflows' | 'permissions';

const TABS = [
    { id: 'connection' as const, labelKey: 'settings.n8n.tab_connection', label: 'Connection', Icon: Link2 },
    { id: 'workflows' as const, labelKey: 'settings.n8n.tab_workflows', label: 'Workflows', Icon: Workflow },
    { id: 'permissions' as const, labelKey: 'settings.n8n.tab_permissions', label: 'Permissions', Icon: ShieldCheck },
];

/** Settings → Organisation → Integrations → n8n: connection, workflows as AI tools, permissions. */
export default function N8nSection() {
    const { t } = useTranslation();
    const [tab, setTab] = useState<N8nTab>('connection');
    const flash = useFlashMessage();
    const wfs = useN8nWorkflows(flash);
    const conn = useN8nConnection(flash, wfs);
    const perms = useN8nPermissions(flash);

    const loadInitial = useEffectEvent(() => { conn.loadConfig(); });
    useEffect(() => { loadInitial(); }, []);

    const loadForTab = useEffectEvent(() => {
        if (tab === 'permissions' && !perms.permSummary) perms.loadPermissions();
        if (tab === 'connection' && conn.configured && !conn.diag) conn.loadDiagnostics();
    });
    useEffect(() => { loadForTab(); }, [tab, conn.configured]);

    if (conn.loading) {
        return (
            <div className="flex items-center justify-center py-4 text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t('common.loading', 'Loading...')}
            </div>
        );
    }

    const { message } = flash;
    return (
        <div className="space-y-3">
            {/* Status row — shows live pill regardless of tab */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <StatusPill configured={conn.configured} testResult={conn.testResult} />
                {message && (
                    <span className={`text-xs font-medium px-3 py-1.5 rounded-lg ${message.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                        {message.text}
                    </span>
                )}
            </div>
            <Tabs
                value={tab}
                onChange={setTab}
                size="sm"
                ariaLabel="n8n"
                items={TABS.map(({ id, labelKey, label, Icon }) => ({ id, label: t(labelKey, label), icon: <Icon className="w-3.5 h-3.5" /> }))}
            />
            {tab === 'connection' && <N8nConnectionTab conn={conn} saving={wfs.saving} onGotoPermissions={() => setTab('permissions')} />}
            {tab === 'workflows' && <N8nWorkflowsTab configured={conn.configured} wfs={wfs} />}
            {tab === 'permissions' && (
                <N8nPermissionsTab
                    loading={perms.permLoading}
                    summary={perms.permSummary}
                    onReload={perms.loadPermissions}
                    onMutate={perms.mutatePermission}
                    onCreateAndGrant={perms.createGroupAndGrant}
                />
            )}
        </div>
    );
}

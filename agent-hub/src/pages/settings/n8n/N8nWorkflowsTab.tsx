import { Check, Info, Plus, RefreshCw, Search, Workflow } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import WorkflowRow from './N8nWorkflowEditor';
import type { N8nWorkflows } from './useN8nState';

/** Discovered workflows that are not configured yet (or are, marked "Added"). */
function DiscoveredList({ wfs }: { wfs: N8nWorkflows }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border p-3 space-y-1.5 border-[var(--border-subtle)]">
            <div className="flex items-center justify-between mb-1">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{t('settings.n8n.available_to_add', 'Available to add')}</h4>
            </div>
            {wfs.filteredDiscovered.map(dw => {
                const alreadyAdded = wfs.workflows.some(w => w.id === dw.id);
                return (
                    <div key={dw.id} className="flex items-center justify-between px-3 py-2 rounded-lg border"
                        style={{ borderColor: 'var(--border-subtle)', background: alreadyAdded ? 'rgba(16, 185, 129, 0.04)' : 'transparent' }}>
                        <div className="min-w-0">
                            <div className="text-sm font-medium truncate text-[var(--text-primary)]">{dw.name}</div>
                            <div className="text-xs truncate text-[var(--text-muted)]">
                                {dw.webhookNodes?.map(n => `${n.method || 'POST'} /webhook/${n.path}`).join(', ')}
                            </div>
                        </div>
                        {alreadyAdded ? (
                            <span className="text-xs font-medium flex items-center gap-1 shrink-0" style={{ color: '#10b981' }}>
                                <Check className="w-3.5 h-3.5" /> {t('settings.n8n.added', 'Added')}
                            </span>
                        ) : (
                            <button onClick={() => wfs.addWorkflow(dw)}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all hover:opacity-80 shrink-0"
                                style={{ background: 'var(--accent-primary)', color: 'white' }}>
                                <Plus className="w-3 h-3" /> {t('settings.n8n.add', 'Add')}
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** The configured workflows with "Save All". */
function ConfiguredList({ wfs }: { wfs: N8nWorkflows }) {
    const { t } = useTranslation();
    const { workflows } = wfs;
    if (workflows.length === 0) {
        return (
            <div className="rounded-lg border px-4 py-6 text-center border-[var(--border-subtle)] text-[var(--text-muted)]">
                <Workflow className="w-5 h-5 mx-auto mb-2 opacity-60" />
                <p className="text-sm">{t('settings.n8n.no_workflows_before', 'No workflows configured yet. Click')} <b>{t('settings.n8n.discover_bold', 'Discover')}</b> {t('settings.n8n.no_workflows_after', 'to scan your n8n instance for webhook-triggered workflows.')}</p>
            </div>
        );
    }
    return (
        <div className="rounded-lg border overflow-hidden border-[var(--border-subtle)]">
            <div className="px-3 py-2 border-b flex items-center justify-between border-[var(--border-subtle)]">
                <h4 className="text-xs font-semibold text-[var(--text-primary)]">
                    {t('settings.n8n.workflows_enabled', 'Workflows ({enabled}/{total} enabled)', { enabled: workflows.filter(w => w.enabled).length, total: workflows.length })}
                </h4>
                <button onClick={wfs.saveWorkflows} disabled={wfs.saving}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: 'white' }}>
                    {wfs.saving ? t('settings.n8n.saving', 'Saving...') : t('settings.n8n.save_all', 'Save All')}
                </button>
            </div>
            <div className="divide-y border-[var(--border-subtle)]">
                {wfs.filteredWorkflows.map(wf => <WorkflowRow key={wf.id} wf={wf} wfs={wfs} />)}
            </div>
        </div>
    );
}

/** Search, discovery on the instance, and the configured workflows. */
export default function N8nWorkflowsTab({ configured, wfs }: { configured: boolean; wfs: N8nWorkflows }) {
    const { t } = useTranslation();
    if (!configured) {
        return (
            <div className="rounded-lg border px-4 py-6 text-center border-[var(--border-subtle)] text-[var(--text-muted)]">
                <Info className="w-5 h-5 mx-auto mb-2 opacity-60" />
                <p className="text-sm">{t('settings.n8n.connect_first', 'Connect to n8n first — fill in the URL and API key on the Connection tab.')}</p>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            {/* Search + Refresh */}
            <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                    <input
                        type="text" value={wfs.wfSearch} onChange={e => wfs.setWfSearch(e.target.value)}
                        placeholder={t('settings.n8n.search_workflows', 'Search workflows...')}
                        className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)]"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    />
                </div>
                <button
                    onClick={wfs.discoverWorkflows} disabled={wfs.discovering}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${wfs.discovering ? 'animate-spin' : ''}`} />
                    {wfs.discovering ? t('settings.n8n.scanning', 'Scanning...') : t('settings.n8n.discover', 'Discover')}
                </button>
            </div>
            {wfs.filteredDiscovered.length > 0 && <DiscoveredList wfs={wfs} />}
            <ConfiguredList wfs={wfs} />
        </div>
    );
}

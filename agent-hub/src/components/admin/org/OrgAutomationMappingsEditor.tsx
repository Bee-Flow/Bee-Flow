// Organisation settings › Answer Reuse (the automations' own settings) ›
// "Update mappings when an automation is opened" (M8b of the data-mapping
// work). Off by default. On: when someone who may edit an automation opens
// it, Bee rewrites the fields whose result provably stays the same (the
// "Update mappings" action, without the dialog), as a new version they can
// undo. The AI's suggestions are never applied this way.

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
    useOrgAutomationMappings, useSaveOrgAutomationMappings, type OrgAutomationMappingSettings,
} from '../../../api/queries/orgAutomationMappings';
import { useTranslation } from '../../../hooks/useTranslation';
import Toggle from '../../shared/Toggle';

function Switch({ orgId, server }: { orgId: string; server: OrgAutomationMappingSettings }) {
    const { t } = useTranslation();
    const save = useSaveOrgAutomationMappings(orgId);
    const [status, setStatus] = useState<'saved' | 'failed' | 'forbidden' | null>(null);
    const onChange = (next: boolean) => {
        setStatus(null);
        save.mutate(next, {
            onSuccess: () => setStatus('saved'),
            onError: (e) => setStatus((e as { status?: number }).status === 403 ? 'forbidden' : 'failed'),
        });
    };
    return (
        <div className="space-y-3">
            <div className="rounded-xl border border-[var(--border-subtle)] p-4">
                <Toggle checked={server.autoUpgradeOnOpen} disabled={save.isPending} onChange={onChange}
                    label={t('mapping.org_setting.toggle', 'Update mappings automatically when an automation is opened')}
                    description={t('mapping.org_setting.toggle_desc', 'Bee rewrites only the fields whose result stays exactly the same on the last runs, and saves that as a new version that can be undone. AI suggestions are never applied this way.')} />
            </div>
            <div className="min-h-[1.25rem] flex items-center gap-2 text-sm">
                {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)]" aria-hidden="true" />}
                {status === 'saved' && <span role="status" className="text-[var(--text-secondary)]">{t('mapping.org_setting.saved', 'Saved.')}</span>}
                {status === 'failed' && <span role="alert" className="text-[var(--error-ink)]">{t('mapping.org_setting.save_failed', 'Could not save this setting. Try again.')}</span>}
                {status === 'forbidden' && <span role="alert" className="text-[var(--error-ink)]">{t('mapping.org_setting.forbidden', 'Only an admin of this organisation can change this.')}</span>}
            </div>
        </div>
    );
}

export default function OrgAutomationMappingsEditor({ orgId }: { orgId: string | null | undefined }) {
    const { t } = useTranslation();
    const query = useOrgAutomationMappings(orgId);
    if (!orgId) return null;
    return (
        <section className="space-y-4 p-1" data-testid="org-automation-mappings" aria-labelledby="org-automation-mappings-title">
            <header>
                <h2 id="org-automation-mappings-title" className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
                    <RefreshCw className="h-5 w-5" aria-hidden="true" />
                    {t('mapping.org_setting.title', 'Updating automation mappings')}
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t('mapping.org_setting.intro', 'Older automations keep their fields as formulas. Anyone who may edit one is offered an update when they open it; this decides whether Bee applies it by itself.')}
                </p>
            </header>
            {query.isPending && (
                <div className="flex items-center gap-2 p-2 text-sm text-[var(--text-secondary)]" role="status">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('mapping.org_setting.loading', 'Loading…')}
                </div>
            )}
            {query.isError && (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]" role="alert">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 text-[var(--error-ink)]" aria-hidden="true" />
                    <span className="flex-1">{t('mapping.org_setting.load_failed', 'Could not load this setting.')}</span>
                    <button type="button" onClick={() => query.refetch()} className="text-sm underline">{t('mapping.org_setting.retry', 'Try again')}</button>
                </div>
            )}
            {query.data && <Switch key={orgId} orgId={orgId} server={query.data} />}
        </section>
    );
}

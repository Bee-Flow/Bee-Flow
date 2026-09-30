// Organisation settings › AI context › "Edit together in real time": whether
// members may type in the same project notebook or page at the same time.
// The switch applies at once; turning it off asks first, because every
// document being edited together is folded back into a single-writer one.
// The operator can switch it off for the whole server (COLLAB_ENABLED=0):
// then the switch is shown locked with that reason, never as a lie.

import { AlertTriangle, Loader2, UsersRound } from 'lucide-react';
import React, { useState } from 'react';
import { useOrgCollab, useSaveOrgCollab, type OrgCollabSettings } from '../../../api/queries/orgCollab';
import { useTranslation } from '../../../hooks/useTranslation';
import ConfirmDialog from '../../shared/ConfirmDialog';
import Toggle from '../../shared/Toggle';

function Switch({ orgId, server }: { orgId: string; server: OrgCollabSettings }) {
    const { t } = useTranslation();
    const save = useSaveOrgCollab(orgId);
    const [confirmOff, setConfirmOff] = useState(false);
    const [status, setStatus] = useState<'saved' | 'failed' | 'forbidden' | null>(null);
    const busy = save.isPending;

    const apply = (next: boolean) => new Promise<void>((resolve) => {
        setStatus(null);
        save.mutate(next, {
            onSuccess: () => { setStatus('saved'); resolve(); },
            onError: (e) => { setStatus((e as { status?: number }).status === 403 ? 'forbidden' : 'failed'); resolve(); },
        });
    });
    const onChange = (next: boolean) => {
        if (next) { void apply(true); return; }
        setConfirmOff(true);
    };

    return (
        <div className="space-y-3">
            <div className="rounded-xl border border-[var(--border-subtle)] p-4">
                <Toggle checked={server.collabEnabled && !server.serverDisabled} disabled={busy || server.serverDisabled} onChange={onChange}
                    label={t('editor.org_collab_toggle', 'Let members edit project notebooks and pages together')}
                    description={t('editor.org_collab_toggle_desc', 'Everyone in the project sees changes as they are typed, with each person\'s cursor. When this is off, one person saves at a time and a save that crosses another one asks which version to keep.')} />
            </div>
            {server.serverDisabled && (
                <p className="m-0 text-xs text-[var(--text-muted)]" data-testid="org-collab-server-off">
                    {t('editor.org_collab_server_off', 'Switched off for this server by the operator. Nobody can edit together until the operator switches it on again.')}
                </p>
            )}
            <div className="min-h-[1.25rem] flex items-center gap-2 text-sm">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)]" aria-hidden="true" />}
                {status === 'saved' && <span role="status" className="text-[var(--text-secondary)]">{t('editor.org_collab_saved', 'Saved.')}</span>}
                {status === 'failed' && <span role="alert" className="text-[var(--error-ink)]">{t('editor.org_collab_save_failed', 'Could not save this setting. Try again.')}</span>}
                {status === 'forbidden' && <span role="alert" className="text-[var(--error-ink)]">{t('editor.org_collab_forbidden', 'Only an admin of this organisation can change this.')}</span>}
            </div>
            <ConfirmDialog
                open={confirmOff}
                title={t('editor.org_collab_off_title', 'Stop editing together?')}
                description={t('editor.org_collab_off_desc', 'Notebooks and pages that are being edited together are saved as they are and go back to one person saving at a time. Nothing is lost. People who have one open are told, and can keep working.')}
                confirmLabel={t('editor.org_collab_off_confirm', 'Switch off')}
                cancelLabel={t('editor.org_collab_cancel', 'Cancel')}
                onConfirm={async () => { await apply(false); setConfirmOff(false); }}
                onCancel={() => setConfirmOff(false)}
            />
        </div>
    );
}

/**
 * `enabled` false (Projects cannot be used here: plan or operator switch,
 * useProjectsAvailable) shows nothing and reads nothing — the setting only
 * acts inside projects.
 */
export default function OrgCollabEditor({ orgId, enabled = true }: { orgId: string | null | undefined; enabled?: boolean }) {
    const { t } = useTranslation();
    const query = useOrgCollab(enabled ? orgId : null);
    if (!orgId || !enabled) return null;
    return (
        <section className="space-y-4 p-1" data-testid="org-collab" aria-labelledby="org-collab-title">
            <header>
                <h2 id="org-collab-title" className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
                    <UsersRound className="h-5 w-5" aria-hidden="true" />
                    {t('editor.org_collab_title', 'Edit together in real time')}
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t('editor.org_collab_intro', 'Whether members of a project can type in the same notebook or page at the same time.')}
                </p>
            </header>
            {query.isPending && (
                <div className="flex items-center gap-2 p-2 text-sm text-[var(--text-secondary)]" role="status">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('editor.org_collab_loading', 'Loading…')}
                </div>
            )}
            {query.isError && (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]" role="alert">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 text-[var(--error-ink)]" aria-hidden="true" />
                    <span className="flex-1">{t('editor.org_collab_load_failed', 'Could not load this setting.')}</span>
                    <button type="button" onClick={() => query.refetch()} className="text-sm underline">{t('editor.org_collab_retry', 'Try again')}</button>
                </div>
            )}
            {query.data && <Switch key={orgId} orgId={orgId} server={query.data} />}
        </section>
    );
}

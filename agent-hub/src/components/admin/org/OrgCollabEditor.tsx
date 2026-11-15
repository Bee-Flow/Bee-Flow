// Organisation settings › Projects › "Edit together in real time": whether
// members may type in the same project notebook or page at the same time.
// The switch applies at once; turning it off asks first, because every
// document being edited together is folded back into a single-writer one.
// The operator can switch it off for the whole server (COLLAB_ENABLED=0):
// then the switch is shown locked with that reason, never as a lie.
// It shares its page with "AI that joins by itself", so it opens with its own
// sub-heading; the page title is the dashboard frame's (AdminPage).

import { useState } from 'react';
import { useOrgCollab, useSaveOrgCollab, type OrgCollabSettings } from '@/api/queries/orgCollab';
import { useTranslation } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import SaveStatus from '@/components/shared/SaveStatus';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import OrgEditorLoad from './OrgEditorLoad';
import { errorStatus } from '@/utils/caughtError';

type Outcome = 'failed' | 'forbidden' | null;

function Switch({ orgId, server }: { orgId: string; server: OrgCollabSettings }) {
    const { t } = useTranslation();
    const save = useSaveOrgCollab(orgId);
    const [confirmOff, setConfirmOff] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>(null);
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const busy = save.isPending;

    const apply = (next: boolean) => new Promise<void>((resolve) => {
        setOutcome(null);
        save.mutate(next, {
            onSuccess: () => { setSavedAt(new Date()); resolve(); },
            onError: (e) => { setOutcome(errorStatus(e) === 403 ? 'forbidden' : 'failed'); resolve(); },
        });
    });
    const onChange = (next: boolean) => {
        if (next) { void apply(true); return; }
        setConfirmOff(true);
    };

    return (
        <div className="space-y-3">
            <SettingsList>
                <Toggle flat checked={server.collabEnabled && !server.serverDisabled} disabled={busy || server.serverDisabled} onChange={onChange}
                    label={t('editor.org_collab_toggle', 'Let members edit project notebooks and pages together')}
                    description={t('editor.org_collab_toggle_desc', 'Everyone in the project sees changes as they are typed, with each person\'s cursor. When this is off, one person saves at a time and a save that crosses another one asks which version to keep.')} />
            </SettingsList>
            {server.serverDisabled && (
                <p className="m-0 text-xs text-[var(--text-muted)]" data-testid="org-collab-server-off">
                    {t('editor.org_collab_server_off', 'Switched off for this server by the operator. Nobody can edit together until the operator switches it on again.')}
                </p>
            )}
            {/* The switch saves on its own: say so, and show that it did (a locked one applies nothing). */}
            <div className="flex min-h-[1.25rem] flex-wrap items-center gap-3 text-xs">
                {!server.serverDisabled && <span className="text-[var(--text-muted)]">{t('admin_org_ai.applies_immediately', 'Applies immediately')}</span>}
                <SaveStatus saveState={busy ? 'saving' : 'idle'} lastSavedAt={savedAt} showWhenIdle size={12} />
                {outcome === 'failed' && <span role="alert" className="text-[var(--error-ink)]">{t('editor.org_collab_save_failed', 'Could not save this setting. Try again.')}</span>}
                {outcome === 'forbidden' && <span role="alert" className="text-[var(--error-ink)]">{t('editor.org_collab_forbidden', 'Only an admin of this organisation can change this.')}</span>}
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
        <SettingsGroup
            title={t('editor.org_collab_title', 'Edit together in real time')}
            description={t('editor.org_collab_intro', 'Whether members of a project can type in the same notebook or page at the same time.')}
        >
            <div data-testid="org-collab">
                <OrgEditorLoad
                    loading={query.isPending}
                    error={query.isError ? t('editor.org_collab_load_failed', 'Could not load this setting.') : null}
                    onRetry={() => { void query.refetch(); }}
                >
                    {query.data && <Switch key={orgId} orgId={orgId} server={query.data} />}
                </OrgEditorLoad>
            </div>
        </SettingsGroup>
    );
}

import type React from 'react';
import { useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { useBuilderConfirm } from '../BuilderConfirmContext';
import {
    useRestoreVersionMutation, useVersionsQuery, type VersionRow,
} from '../../../../api/queries/automation/versions';
import VersionList from './VersionList';
import VersionCompare from './VersionCompare';
import VersionOpenDialog from './VersionOpenDialog';
import { describeVersion } from './versionText';

interface AutomationLike {
    id?: string | null;
    version?: number | null;
    liveVersion?: number | null;
    liveAt?: string | null;
}

interface Props {
    automation: AutomationLike | null | undefined;
    /** Called with the updated automation row after a restore. */
    onRestored?: (automation: Record<string, unknown> | null) => void;
}

type Confirm = (opts: { title: string; description?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean>;

function versionContext(a: AutomationLike | null | undefined) {
    return { liveVersion: a?.liveVersion ?? null, liveAt: a?.liveAt ?? null, currentVersion: a?.version ?? null };
}

/** The clicked row, else the working copy, else the newest. */
function pickSelected(rows: VersionRow[], selectedId: string | null): VersionRow | null {
    return rows.find((r) => r.id === selectedId) ?? rows.find((r) => r.isEditing) ?? rows[0] ?? null;
}

/** The restore question, then the restore; resets the selection on success. */
function useRestoreFlow(automation: AutomationLike | null | undefined, onRestored: Props['onRestored'], onDone: () => void) {
    const { t } = useTranslation();
    const confirmAction = useBuilderConfirm() as unknown as Confirm | null;
    const restore = useRestoreVersionMutation(automation?.id ?? '');
    const run = async (target: VersionRow) => {
        const params = { version: target.version };
        const description = automation?.liveVersion != null
            ? t('routines.versions.restoreConfirmLive', 'Your working copy goes back to v{version}. What runs now stays live until you make it live.', params)
            : t('routines.versions.restoreConfirm', 'The routine goes back to how it looked in v{version}; the current steps are replaced.', params);
        const ok = !confirmAction || await confirmAction({
            title: t('routines.versions.restoreConfirmTitle', 'Restore v{version}?', params),
            description,
            confirmLabel: t('routines.versions.restore', 'Restore'),
            destructive: true,
        });
        if (!ok) return;
        const updated = await restore.mutateAsync(target.id).catch(() => undefined);
        if (updated === undefined) return;
        onDone();
        onRestored?.(updated);
    };
    return { run, restore };
}

function ListPane({ query, ...listProps }: {
    query: { isError: boolean; isLoading: boolean };
} & React.ComponentProps<typeof VersionList>) {
    const { t } = useTranslation();
    if (query.isError) {
        return <div role="alert" className="p-4 text-[12px] text-[var(--error)]">{t('routines.versions.listFailed', 'The versions could not be loaded.')}</div>;
    }
    if (query.isLoading) return <div className="p-4 text-[12px] text-[var(--text-tertiary)]">{t('common.loading', 'Loading…')}</div>;
    return <VersionList {...listProps} />;
}

/**
 * Studio → Automations → Versions (handoff 5, artboard 5d): History on the
 * left, grouped by what is live; on the right what the selected version
 * changed compared with another, per setting. The columns stack when the
 * tab itself is narrow (its own container, not the viewport).
 */
export default function VersionsTab({ automation, onRestored }: Props) {
    const { t } = useTranslation();
    const automationId = automation?.id ?? null;
    const versions = useVersionsQuery(automationId, versionContext(automation));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [milestones, setMilestones] = useState(false);
    const [openRow, setOpenRow] = useState<VersionRow | null>(null);
    const { run: onRestore, restore } = useRestoreFlow(automation, onRestored, () => setSelectedId(null));

    if (!automationId) {
        return (
            <div className="p-6 text-sm text-[var(--text-tertiary)]">
                {t('routines.versions.unsaved', 'Versions appear here once this routine has been saved for the first time.')}
            </div>
        );
    }

    const rows = versions.data ?? [];
    const selected = pickSelected(rows, selectedId);

    return (
        <div className="@container/versions h-full min-h-0">
            <div className="h-full min-h-0 grid grid-cols-1 grid-rows-[minmax(0,40%)_minmax(0,1fr)] @[900px]/versions:grid-rows-1 @[900px]/versions:grid-cols-[480px_minmax(0,1fr)]">
                <div className="min-h-0 flex flex-col border-b @[900px]/versions:border-b-0 @[900px]/versions:border-r border-[var(--border-default)]">
                    <ListPane
                        query={versions}
                        rows={rows}
                        selectedId={selected?.id ?? null}
                        onSelect={(r) => setSelectedId(r.id)}
                        milestones={milestones}
                        onMilestonesChange={setMilestones}
                    />
                </div>
                <div className="min-h-0 min-w-0 flex flex-col bg-[var(--bg-primary)]">
                    {restore.isError && (
                        <div role="alert" className="mx-7 mt-4 text-[12px] text-[var(--error)]">
                            {restore.error?.message || t('routines.versions.restoreFailed', 'The version could not be restored.')}
                        </div>
                    )}
                    {selected ? (
                        <VersionCompare
                            key={selected.id}
                            automationId={automationId}
                            rows={rows}
                            selected={selected}
                            restoring={restore.isPending}
                            onRestore={onRestore}
                            onOpen={setOpenRow}
                        />
                    ) : null}
                </div>
            </div>
            {openRow && (
                <VersionOpenDialog
                    automationId={automationId}
                    versionId={openRow.id}
                    version={openRow.version}
                    title={openRow.name ?? describeVersion(openRow, t)}
                    onClose={() => setOpenRow(null)}
                />
            )}
        </div>
    );
}

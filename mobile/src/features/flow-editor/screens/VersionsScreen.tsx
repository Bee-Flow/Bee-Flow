/**
 * An automation's version history — the web builder's Versions tab (handoff 5):
 * every save, newest first, grouped into Not live yet / Live / Earlier; tap
 * one to see what changed (against the automation as it is saved now, or
 * another save), and restore it after a confirmation.
 *
 * A restore is a save: the draft is saved first (so what is on screen
 * becomes a version of its own and the restore can itself be undone from
 * this list), the server validates the old definition again, and the
 * restored flow replaces the open draft as one undo step
 * (useRestoreVersion). The list then shows the restore as a new version.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import type { FlowVersionSummary } from '../api';
import { useVersionRestore } from '../components/versions/useVersionRestore';
import { VersionDiffSheet } from '../components/versions/VersionDiffSheet';
import { VersionList } from '../components/versions/VersionList';
import { useDraftState, useFlowDraft, useFlowId, useVersions } from '../hooks';

export interface VersionsScreenProps {
    /** The automation id (or an open new automation's draft key). */
    automationId: string;
}

export function VersionsScreen({ automationId }: VersionsScreenProps) {
    const t = useTranslation();
    const flow = useFlowDraft(automationId);
    const id = useFlowId(flow.key);
    const versions = useVersions(id);
    const refresh = useUserRefresh(() => versions.refetch());
    const storeVersion = useDraftState(flow.store, (s) => s.version);
    const baseline = useDraftState(flow.store, (s) => s.baseline);
    const current = storeVersion ?? flow.automation?.version ?? null;
    const [open, setOpen] = useState<FlowVersionSummary | null>(null);
    const { restoringId, restore } = useVersionRestore(flow.key, () => setOpen(null));
    const list = versions.data ?? [];

    let body: React.ReactElement;
    if (!id) body = <EmptyState icon="History" title={t('mobile.flow.versions.not_saved', 'Nothing saved yet')} />;
    else if (versions.isLoading) body = <ListSkeleton />;
    else if (versions.isError) body = <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
    else if (!list.length) body = <EmptyState icon="History" title={t('automations.versions.empty', 'No saved versions yet.')} />;
    else {
        body = (
            <VersionList
                versions={list}
                current={current}
                restoringId={restoringId}
                onOpen={setOpen}
                onRestore={restore}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
            />
        );
    }

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={t('automation_editor.version_history', 'Version history')} subtitle={flow.automation?.title || undefined} />
            {body}
            {open && id ? (
                <VersionDiffSheet
                    automationId={id}
                    version={open}
                    versions={list}
                    currentVersion={current}
                    currentDefinition={baseline}
                    restoring={restoringId === open.id}
                    onRestore={restore}
                    onClose={() => setOpen(null)}
                />
            ) : null}
        </Screen>
    );
}

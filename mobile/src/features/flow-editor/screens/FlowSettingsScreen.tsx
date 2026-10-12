/**
 * An automation's settings — the web builder's Settings tab (settings/SettingsPage.tsx)
 * and what hangs off the automation rather than its flow: its name and
 * description, who gets notified of which runs, its webhook URLs, its
 * folder and owner, its AI Act declaration, this device's editor preference,
 * export and import, and deleting it.
 *
 * It opens the automation's draft (the same store the build screen edits), so
 * a notification change here is an undoable draft edit saved by the
 * autosave, and the build screen shows it at once.
 */

import { useNavigation, useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { ErrorState, GroupedScroll, LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import { buildPath } from '../components/outline/stepRoute';
import { ComplianceGroup } from '../components/settings/ComplianceGroup';
import { DangerGroup } from '../components/settings/DangerGroup';
import { DetailsGroup } from '../components/settings/DetailsGroup';
import { EditorGroup } from '../components/settings/EditorGroup';
import { leaveDeletedAutomation } from '../components/settings/leaveDeletedAutomation';
import { NotificationsGroup } from '../components/settings/NotificationsGroup';
import { PlacementGroup } from '../components/settings/PlacementGroup';
import { TransferGroup } from '../components/settings/TransferGroup';
import { WebhooksGroup } from '../components/settings/WebhooksGroup';
import { useDraftState, useFlowDraft } from '../hooks';

export interface FlowSettingsScreenProps {
    /** The automation id (or an open new automation's draft key). */
    automationId: string;
}

export function FlowSettingsScreen({ automationId }: FlowSettingsScreenProps) {
    const t = useTranslation();
    const router = useRouter();
    const navigation = useNavigation();
    const flow = useFlowDraft(automationId);
    const refresh = useUserRefresh(flow.refetch);
    const ready = useDraftState(flow.store, (s) => s.ready);
    const row = flow.automation;
    const title = row?.title ?? '';
    const header = <ScreenHeader title={t('mobile.flow.settings.title', 'Settings')} subtitle={title || undefined} />;
    if (!ready) {
        return (
            <Screen edges={['top']}>
                {header}
                {flow.error ? <ErrorState error={flow.error} onRetry={flow.refetch} /> : <LoadingState />}
            </Screen>
        );
    }
    return (
        <Screen edges={['top']} avoidKeyboard>
            {header}
            <GroupedScroll keyboardShouldPersistTaps="handled" refresh={refresh} testID="flow-settings">
                {row ? <DetailsGroup flowKey={flow.key} title={row.title} description={row.description ?? ''} /> : null}
                <NotificationsGroup store={flow.store} title={title} automationId={row?.id ?? null} ownerId={row?.userId} />
                {row ? <WebhooksGroup flowKey={flow.key} store={flow.store} /> : null}
                {row ? <PlacementGroup flowKey={flow.key} folderId={row.folderId} /> : null}
                {row ? <ComplianceGroup automationId={row.id} /> : null}
                <EditorGroup />
                <TransferGroup flowKey={flow.key} title={title} onImported={(id) => router.push(buildPath(id))} />
                <DangerGroup
                    automation={row ? { id: row.id, title: row.title } : null}
                    onDeleted={() => row && leaveDeletedAutomation(router, navigation.getState()?.routes ?? [], row.id)}
                />
            </GroupedScroll>
        </Screen>
    );
}

/**
 * Nextcloud Sync (web: OrganisationSection.jsx "Nextcloud Sync", the page
 * with OrgNcPairingPanel, NextcloudSyncPanel, MeetingNotesAdminPanel and
 * GoogleMeetAdminPanel). The phone keeps the sync on this screen and opens
 * the other three from its first group: pairing a new Nextcloud (an NC-bound
 * org, or the platform operator) and the Talk and Google Meet meeting-notes
 * settings (the Meeting Notes licence).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgLockedScreen } from '@/features/org';
import { useConfirmLeave, useUserRefresh } from '@/shared/patterns';
import { ErrorState, Group, GroupedScroll, LoadingState, NoteRow, SaveBar, Screen, ScreenHeader } from '@/shared/ui';

import { NcLinksGroup } from '../components/NcLinksGroup';
import { NcSyncedUsersGroup } from '../components/NcSyncedUsersGroup';
import { NcSyncSettingsGroups } from '../components/NcSyncSettingsGroups';
import { NcSyncStatusGroup } from '../components/NcSyncStatusGroup';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { useNcSyncPage } from '../hooks/useNcSyncPage';

export function NextcloudScreen() {
    const t = useTranslation();
    const access = useIntegrationAccess();
    const page = useNcSyncPage(access.admin && access.isNcOrg ? access.orgId : null);
    useConfirmLeave(page.form.dirty);
    const refresh = useUserRefresh(page.refetch);
    const title = t('settings.nextcloud_sync', 'Nextcloud Sync');
    if (!access.admin) return <OrgLockedScreen title={title} />;
    const { sync, form } = page;

    return (
        <Screen edges={['top', 'bottom']} inset>
            <ScreenHeader title={title} />
            <GroupedScroll refresh={refresh} keyboardShouldPersistTaps="handled">
                <NcLinksGroup pairing={access.isNcOrg || access.isSuperAdmin} meetingNotes={access.meetingNotes} />
                {!access.isNcOrg ? (
                    <Group>
                        <NoteRow>
                            {t('mobile.orgIntegrations.nc_not_bound', 'Nextcloud sync is only available for organisations bound to a Nextcloud instance.')}
                        </NoteRow>
                    </Group>
                ) : null}
                {access.isNcOrg && sync.isLoading ? <LoadingState /> : null}
                {access.isNcOrg && sync.isError ? <ErrorState error={sync.error} onRetry={page.refetch} /> : null}
                {sync.data && form.draft ? (
                    <>
                        <NcSyncStatusGroup sync={sync.data} users={page.users} syncing={page.syncing} onSyncNow={() => void page.syncNow()} />
                        <NcSyncSettingsGroups
                            draft={form.draft}
                            groupNames={page.groupNames}
                            groupsError={page.groupsError}
                            disabled={page.saving}
                            onChange={form.set}
                        />
                        <NcSyncedUsersGroup users={page.users} />
                    </>
                ) : null}
            </GroupedScroll>
            <SaveBar dirty={form.dirty} saving={page.saving} onSave={() => void page.save()} onDiscard={form.reset} />
        </Screen>
    );
}

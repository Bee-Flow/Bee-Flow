/**
 * Organisation: the index of everything an org admin configures, filed in a
 * few themed groups (model/sections.ts ORG_HUB_GROUPS), each row gated the
 * way the web gates it. A search field above finds any organisation screen,
 * the ones below a section included.
 *
 * Two audiences, one screen. A member sees which organisation they are in,
 * its plan and their own privacy settings; an org admin also gets every
 * settings section, with the organisation's website on the Info row and the
 * plan on the License & Usage row. The full licence group appears only where
 * that row cannot carry it: on self-hosted (no such row) or when the licence
 * health reports a problem. A DPO without org-admin sees the Compliance row
 * and nothing else, as on the web.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useAccess } from '@/core/access';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useLicenseStatus, type LicenseStatus } from '@/features/usage';
import { humanise } from '@/shared/lib/display';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, Group, GroupedScroll, Screen, ScreenHeader, SearchField, SettingRow } from '@/shared/ui';

import { OrgLicenceGroup } from '../components/OrgLicenceGroup';
import { OrgProfileGroup } from '../components/OrgProfileGroup';
import { OrgSearchResults } from '../components/OrgSearchResults';
import { OrgSectionsGroup, type SectionValues } from '../components/OrgSectionsGroup';
import { useLicenseHealth } from '../hooks/queries';
import { useOrgSections } from '../hooks/useOrgSections';
import { hubGroups, licenceNeedsAttention, showLicenceGroup } from '../model/orgHub';
import { searchOrgPlaces } from '../model/orgSearch';
import type { LicenseHealth, Organization } from '../model/types';

function PersonalAccount() {
    const router = useRouter();
    const t = useTranslation();
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('settings.organisation', 'Organisation')} />
            <EmptyState
                icon="User"
                title={t('mobile.org.personal_title', 'A personal account')}
                message={t(
                    'mobile.org.personal_message',
                    'You are not part of an organisation, so this is all yours: your plan, your privacy settings and your usage. Nobody else can see any of it.',
                )}
                actionLabel={t('mobile.org.personal_action', 'Open your plan')}
                onAction={() => router.push('/usage')}
            />
        </Screen>
    );
}

/** The values the index's rows carry: the website on Info, the plan on the licence. */
function rowValues(
    org: Organization | null | undefined,
    license: LicenseStatus | null | undefined,
    health: LicenseHealth | null | undefined,
): SectionValues {
    return {
        info: org?.website ? { text: org.website } : undefined,
        license: license
            ? { text: humanise(license.tier || 'community'), warning: licenceNeedsAttention(license, health) }
            : undefined,
    };
}

function OrgHub({ orgId }: { orgId: string }) {
    const router = useRouter();
    const t = useTranslation();
    const { user } = useAuth();
    const access = useAccess();
    const isOrgAdmin = access.isOrgAdmin;
    const [query, setQuery] = useState('');
    const { sections, org, refetch } = useOrgSections();
    const license = useLicenseStatus();
    const health = useLicenseHealth(isOrgAdmin);
    const name = org.data?.name || user?.organization?.name || orgId;
    const searching = query.trim().length > 0;

    const refresh = useUserRefresh(() =>
        Promise.all([refetch(), license.refetch(), isOrgAdmin ? health.refetch() : undefined]),
    );
    const hasLicenceRow = sections.some((s) => s.id === 'license');
    const values = rowValues(org.data, license.data, health.data);
    const hub = (
        <>
            {isOrgAdmin ? null : <OrgProfileGroup name={name} license={license.data} />}
            {hubGroups(sections).map(({ group, sections: rows }) => (
                <OrgSectionsGroup key={group.id} title={t(group.title.i18nKey, group.title.en)} sections={rows} values={values} />
            ))}
            {showLicenceGroup(isOrgAdmin, hasLicenceRow, health.data) ? (
                <OrgLicenceGroup license={license.data} health={health.data} />
            ) : null}
            <Group title={t('mobile.org.yours_title', 'Yours')}>
                <SettingRow
                    label={t('mobile.org.your_privacy', 'Your privacy settings')}
                    onPress={() => router.push('/org/privacy')}
                />
            </Group>
        </>
    );
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={name} subtitle={humanise(user?.orgRole ?? user?.role)} />
            <GroupedScroll refresh={refresh} keyboardShouldPersistTaps="handled">
                {sections.length > 0 ? (
                    <SearchField
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('mobile.org.search_placeholder', 'Find an organisation setting')}
                    />
                ) : null}
                {searching ? (
                    <OrgSearchResults places={searchOrgPlaces({ query, access, visible: sections, translate: t })} />
                ) : (
                    hub
                )}
            </GroupedScroll>
        </Screen>
    );
}

export function OrgScreen() {
    const { user } = useAuth();
    const orgId = user?.organizationId ?? null;
    return orgId ? <OrgHub orgId={orgId} /> : <PersonalAccount />;
}

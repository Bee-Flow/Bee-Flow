/**
 * Organisation integrations (web: OrganisationSection.jsx, Integrations):
 * who may use which integration — the access matrix, opened on its
 * integration kind (and, on the phone, its beta kind, which the web keeps
 * under Admin → Access) — and the integrations' own settings: Nextcloud's
 * tools for an NC-bound org, n8n, and the Google Maps key. The org's
 * integration allow-list decides which settings rows show, as on the web.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgLockedScreen } from '@/features/org';
import { useUserRefresh } from '@/shared/patterns';
import { Badge, Group, GroupedScroll, ListRow, NoteRow, Screen, ScreenHeader } from '@/shared/ui';

import { MapsKeySheet } from '../components/MapsKeySheet';
import { useHasMapsKey } from '../hooks/integrationQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';

export function OrgIntegrationsScreen() {
    const t = useTranslation();
    const router = useRouter();
    const access = useIntegrationAccess();
    const allowed = access.enabledIntegrations;
    const showN8n = !allowed || allowed.includes('n8n');
    const showMaps = !allowed || allowed.includes('google-maps');
    const maps = useHasMapsKey(access.admin && showMaps);
    const refresh = useUserRefresh(() => maps.refetch());
    const [mapsOpen, setMapsOpen] = useState(false);
    const title = t('org.integ_title', 'Organisation Integrations');
    if (!access.admin) return <OrgLockedScreen title={title} />;

    return (
        <Screen edges={['top', 'bottom']} inset>
            <ScreenHeader title={title} subtitle={t('org.integ_subtitle', 'Shared across all members of your organisation.')} />
            <GroupedScroll refresh={refresh}>
                <Group
                    title={t('org.integ_tab_access', 'Integration access')}
                    footer={t(
                        'mobile.orgIntegrations.access_hint',
                        'Give an integration to your whole organisation or to a specific group. These are the integrations your subscription includes.',
                    )}
                >
                    <ListRow
                        testID="integrations-access"
                        title={t('mobile.orgIntegrations.access_row', 'Who may use which integration')}
                        chevron
                        onPress={() => router.push('/org/access?kind=integration')}
                    />
                    <ListRow
                        testID="integrations-beta"
                        title={t('mobile.orgIntegrations.beta', 'Beta features')}
                        chevron
                        onPress={() => router.push('/org/access?kind=beta')}
                    />
                </Group>
                <Group
                    title={t('org.integ_tab_settings', 'Integration settings')}
                    footer={t(
                        'mobile.orgIntegrations.settings_hint',
                        'Configure the integrations themselves — credentials, instance URLs and workflows.',
                    )}
                >
                    {access.isNcOrg ? (
                        <ListRow
                            testID="integrations-nextcloud"
                            title={t('mobile.orgIntegrations.nc_title', 'Nextcloud integrations')}
                            subtitle={t('mobile.orgIntegrations.nc_row', 'Which Nextcloud tools your agents may use, per group')}
                            chevron
                            onPress={() => router.push('/org/integrations/nextcloud')}
                        />
                    ) : null}
                    {showN8n ? (
                        <ListRow
                            testID="integrations-n8n"
                            title={t('mobile.orgIntegrations.n8n', 'n8n')}
                            subtitle={t('org.integ_n8n_desc', 'Connect n8n workflows as AI tools')}
                            chevron
                            onPress={() => router.push('/org/n8n')}
                        />
                    ) : null}
                    {showMaps ? (
                        <ListRow
                            testID="integrations-maps"
                            title={t('mobile.orgIntegrations.maps', 'Google Maps')}
                            subtitle={
                                maps.data
                                    ? t('org.integ_maps_configured', 'Maps, directions & places — configured')
                                    : t('org.integ_maps_desc', 'Directions, route maps & places search in chat')
                            }
                            trailing={maps.data ? <Badge label={t('settings.connected', 'Connected')} tone="success" /> : undefined}
                            chevron
                            onPress={() => setMapsOpen(true)}
                        />
                    ) : null}
                    {!showN8n && !showMaps && !access.isNcOrg ? (
                        <NoteRow>
                            {t('org.integ_none', 'No integrations are enabled for this organisation. Contact your platform administrator.')}
                        </NoteRow>
                    ) : null}
                </Group>
            </GroupedScroll>
            <MapsKeySheet visible={mapsOpen} hasKey={maps.data === true} onClose={() => setMapsOpen(false)} />
        </Screen>
    );
}

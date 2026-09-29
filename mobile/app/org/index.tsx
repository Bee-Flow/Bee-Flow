/**
 * Organisation.
 *
 * Two audiences, one screen. A member wants to know which organisation they
 * are in and who to ask; an org admin wants its profile, its people and its
 * policies. Rather than gate the whole screen behind `org_admin` and give
 * members a dead end, every card degrades: `GET /auth/organizations/:id`
 * requires org-admin and answers 403 otherwise, which api.ts folds to null, so
 * a member sees the facts their own session already carries and a line saying
 * the rest belongs to an administrator.
 *
 * Nothing here writes. Editing an organisation's profile, its integrations
 * allow-list and its feature grants is a desktop job — those forms have
 * fifteen fields each and consequences for everybody in the company. Saying
 * so plainly is better than shipping a cramped version of them.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    getLicenseStatus,
    getOrganization,
    listOrgMembers,
    settingsKeys,
} from '../../src/features/settings/api';
import { humanise } from '../../src/features/settings/format';
import { useIsOrgAdmin } from '../../src/features/settings/permissions';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { EmptyState } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function OrgScreen() {
    const theme = useTheme();
    const router = useRouter();
    const { user } = useAuth();
    const isOrgAdmin = useIsOrgAdmin();

    const orgId = user?.organizationId ?? null;

    const org = useQuery({
        queryKey: settingsKeys.org(orgId ?? 'none'),
        queryFn: ({ signal }) => (orgId ? getOrganization(orgId, signal) : Promise.resolve(null)),
        enabled: Boolean(orgId),
        staleTime: 5 * 60_000,
    });

    const members = useQuery({
        queryKey: settingsKeys.orgMembers,
        queryFn: ({ signal }) => listOrgMembers(signal),
        enabled: isOrgAdmin,
        retry: false,
        staleTime: 60_000,
    });

    const license = useQuery({
        queryKey: settingsKeys.license,
        queryFn: ({ signal }) => getLicenseStatus(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });

    if (!orgId) {
        return (
            <Screen edges={['top']} inset>
                <ScreenHeader title="Organisation" />
                <EmptyState
                    icon="user"
                    title="A personal account"
                    message="You are not part of an organisation, so this is all yours: your plan, your privacy settings and your usage. Nobody else can see any of it."
                    actionLabel="Open your plan"
                    onAction={() => router.push('/usage')}
                />
            </Screen>
        );
    }

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title={org.data?.name ?? orgId}
                subtitle={humanise(user?.orgRole ?? user?.role)}
            />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={org.isRefetching || members.isRefetching}
                        onRefresh={() => {
                            void org.refetch();
                            if (isOrgAdmin) void members.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Group title="Profile">
                    <InfoRow label="Name" value={org.data?.name ?? orgId} />
                    <InfoRow label="Identifier" value={orgId} selectable />
                    <InfoRow label="Your role" value={humanise(user?.orgRole ?? user?.role)} />
                    {org.data?.website ? (
                        <InfoRow label="Website" value={org.data.website} selectable />
                    ) : null}
                    {org.data?.email ? (
                        <InfoRow label="Contact" value={org.data.email} selectable />
                    ) : null}
                    {org.data?.kvk ? <InfoRow label="KvK" value={org.data.kvk} /> : null}
                    {org.data?.vat ? <InfoRow label="VAT" value={org.data.vat} /> : null}
                    {org.data?.description ? (
                        <NoteRow>{org.data.description}</NoteRow>
                    ) : null}
                    {!org.data ? (
                        <NoteRow>
                            The full organisation profile is visible to administrators. Your own
                            membership is shown above.
                        </NoteRow>
                    ) : null}
                </Group>

                <Group title="Plan">
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.spacing.md,
                            paddingHorizontal: theme.spacing.lg,
                            paddingVertical: theme.spacing.md,
                            minHeight: theme.minTouch,
                        }}
                    >
                        <Text variant="body" style={{ flex: 1 }}>
                            Licence tier
                        </Text>
                        <Badge
                            label={humanise(license.data?.tier ?? 'community')}
                            tone={
                                license.data && license.data.tier !== 'community'
                                    ? 'accent'
                                    : 'neutral'
                            }
                        />
                    </View>
                    {license.data?.serverOverride ? (
                        <NoteRow>
                            This installation is covered by a server-wide licence, so every
                            organisation on it shares that tier.
                        </NoteRow>
                    ) : null}
                    <SettingRow
                        label="Usage and spend"
                        icon={
                            <Feather
                                name="bar-chart-2"
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                        }
                        onPress={() => router.push('/usage')}
                    />
                </Group>

                <Group title="Manage">
                    <SettingRow
                        label="Members and roles"
                        value={
                            isOrgAdmin && members.data
                                ? `${members.data.length}`
                                : undefined
                        }
                        icon={<Feather name="users" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/org/members')}
                    />
                    <SettingRow
                        label="Privacy and compliance"
                        icon={<Feather name="shield" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/org/privacy')}
                    />
                    <SettingRow
                        label="Integrations"
                        icon={<Feather name="link" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/integrations')}
                    />
                    {isOrgAdmin ? (
                        <SettingRow
                            label="Administration"
                            icon={
                                <Feather
                                    name="sliders"
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            }
                            onPress={() => router.push('/admin')}
                        />
                    ) : null}
                </Group>

                <Group title="Not on a phone">
                    <NoteRow>
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="body">Editing the organisation</Text>
                            <Text variant="caption" tone="tertiary">
                                Company profile, branding, model and provider configuration, feature
                                grants and the integrations allow-list are edited in the web app.
                                Each is a long form with consequences for everyone in the
                                organisation, and a phone is the wrong place to fill one in by
                                accident.
                            </Text>
                        </View>
                    </NoteRow>
                </Group>
            </ScrollView>
        </Screen>
    );
}

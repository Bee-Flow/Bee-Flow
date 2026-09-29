/**
 * Administration.
 *
 * Read-heavy, and unapologetically so. The question an administrator asks on a
 * phone is "is anything on fire?", not "let me reconfigure the model tiers" —
 * so this screen answers the first and is explicit about where the second
 * lives. Every card here is a probe:
 *
 *   /api/maintenance          is a deploy window announced, and what build is serving?
 *   /api/guard/health         is the PII detector actually reachable?
 *   /api/license/status       what tier is this install on?
 *   /api/license/health       is the licence refresher ticking, is anything past due?
 *   /api/admin/modules        which platform modules are installed…
 *   /api/admin/modules/health …and are any of them crash-looping?
 *   /auth/users               how many people, and how many administrators?
 *
 * Three of those are super-admin only and two need org-admin. Rather than gate
 * the whole screen, each fetch goes through `optional()` in api.ts, which
 * folds a 403 to null so a card simply does not appear. What a person may see
 * is the server's decision, not this file's.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { checkHealth, getServerUrl } from '../../src/api/server';
import {
    getGuardHealth,
    getLicenseHealth,
    getLicenseStatus,
    getMaintenance,
    getModuleHealth,
    listModules,
    listOrgMembers,
    settingsKeys,
} from '../../src/features/settings/api';
import { absoluteDate, humanise } from '../../src/features/settings/format';
import { useIsOrgAdmin, useIsSuperAdmin } from '../../src/features/settings/permissions';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Banner, EmptyState, ListSkeleton } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function AdminScreen() {
    const theme = useTheme();
    const router = useRouter();
    const isOrgAdmin = useIsOrgAdmin();
    const isSuperAdmin = useIsSuperAdmin();

    const server = getServerUrl();

    const health = useQuery({
        queryKey: settingsKeys.health,
        queryFn: () => (server ? checkHealth(server) : Promise.resolve(null)),
        refetchInterval: 60_000,
        retry: false,
    });

    const maintenance = useQuery({
        queryKey: settingsKeys.maintenance,
        queryFn: ({ signal }) => getMaintenance(signal),
        refetchInterval: 60_000,
        retry: false,
    });

    const guard = useQuery({
        queryKey: ['admin', 'guard-health'],
        queryFn: ({ signal }) => getGuardHealth(signal),
        staleTime: 60_000,
        retry: false,
    });

    const license = useQuery({
        queryKey: settingsKeys.license,
        queryFn: ({ signal }) => getLicenseStatus(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });

    const licenseHealth = useQuery({
        queryKey: settingsKeys.licenseHealth,
        queryFn: ({ signal }) => getLicenseHealth(signal),
        enabled: isOrgAdmin,
        staleTime: 60_000,
        retry: false,
    });

    const members = useQuery({
        queryKey: settingsKeys.orgMembers,
        queryFn: ({ signal }) => listOrgMembers(signal),
        enabled: isOrgAdmin,
        staleTime: 60_000,
        retry: false,
    });

    const modules = useQuery({
        queryKey: settingsKeys.modules,
        queryFn: ({ signal }) => listModules(signal),
        enabled: isSuperAdmin,
        staleTime: 60_000,
        retry: false,
    });

    const moduleHealth = useQuery({
        queryKey: settingsKeys.moduleHealth,
        queryFn: ({ signal }) => getModuleHealth(signal),
        enabled: isSuperAdmin,
        staleTime: 60_000,
        retry: false,
    });

    if (!isOrgAdmin && !isSuperAdmin) {
        return (
            <Screen edges={['top']} inset>
                <ScreenHeader title="Administration" />
                <EmptyState
                    icon="lock"
                    title="Not your screen"
                    message="Administration is for people who manage this installation or your organisation. If you need something changed, an administrator can do it."
                    actionLabel="Ask for help"
                    onAction={() => router.push('/support')}
                />
            </Screen>
        );
    }

    const window = maintenance.data?.maintenance;
    const admins = (members.data ?? []).filter(
        (m) => m.role === 'admin' || (m.orgRole ?? '').includes('admin'),
    );
    const brokenModules = (moduleHealth.data?.modules ?? []).filter(
        (m) => m.lastActivationError || m.crashesInWindow > 0 || m.restartAdvised,
    );

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title="Administration"
                subtitle={isSuperAdmin ? 'Platform operator' : 'Organisation administrator'}
            />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={health.isRefetching || maintenance.isRefetching}
                        onRefresh={() => {
                            void health.refetch();
                            void maintenance.refetch();
                            void guard.refetch();
                            void license.refetch();
                            if (isOrgAdmin) void licenseHealth.refetch();
                            if (isSuperAdmin) {
                                void modules.refetch();
                                void moduleHealth.refetch();
                            }
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
                {window?.active ? (
                    <Banner tone="warning" icon="tool">
                        A maintenance window is running{window.reason ? `: ${window.reason}` : ''}.
                        {window.etaSeconds
                            ? ` Expected to take about ${Math.round(window.etaSeconds / 60)} minutes.`
                            : ''}
                    </Banner>
                ) : null}

                <Group
                    title="This installation"
                    footer="Polled while this screen is open. Pull down to check again."
                >
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
                            API
                        </Text>
                        <Badge
                            label={health.data?.ok ? 'Healthy' : 'Unreachable'}
                            tone={health.data?.ok ? 'success' : 'error'}
                        />
                    </View>
                    <InfoRow
                        label="Build"
                        value={
                            health.data?.appVersion || maintenance.data?.appVersion || 'Not reported'
                        }
                        selectable
                    />
                    <InfoRow label="Address" value={server ?? 'Not configured'} selectable />
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
                            PII Guard
                        </Text>
                        <Badge
                            label={guardLabel(guard.data?.status)}
                            tone={guardTone(guard.data?.status)}
                        />
                    </View>
                    {guard.data?.status === 'not-configured' ? (
                        <NoteRow>
                            No PII detector is installed. Privacy Shield settings still save, but
                            nothing is scanned — bring up the <Text variant="code">guard</Text>{' '}
                            profile to enable detection.
                        </NoteRow>
                    ) : null}
                </Group>

                <Group title="Licence">
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
                            Tier
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
                    <InfoRow label="Scope" value={humanise(license.data?.scope ?? 'none')} />
                    {license.data?.license?.expiresAt ? (
                        <InfoRow
                            label="Expires"
                            value={absoluteDate(license.data.license.expiresAt)}
                            tone={
                                expiringSoon(license.data.license.expiresAt) ? 'warning' : 'tertiary'
                            }
                        />
                    ) : null}
                    {license.data?.license?.refreshStatus ? (
                        <InfoRow
                            label="Last refresh"
                            value={humanise(license.data.license.refreshStatus)}
                            tone={
                                license.data.license.refreshStatus === 'ok' ? 'success' : 'warning'
                            }
                        />
                    ) : null}
                    {licenseHealth.data ? (
                        <>
                            <InfoRow
                                label="Refresher"
                                value={licenseHealth.data.refresher.enabled ? 'Running' : 'Off'}
                                tone={licenseHealth.data.refresher.enabled ? 'success' : 'tertiary'}
                            />
                            <InfoRow
                                label="Accounts past due"
                                value={String(licenseHealth.data.dunning.past_due_count)}
                                tone={
                                    licenseHealth.data.dunning.past_due_count > 0
                                        ? 'warning'
                                        : 'tertiary'
                                }
                            />
                            <InfoRow
                                label="Accounts suspended"
                                value={String(licenseHealth.data.dunning.suspended_count)}
                                tone={
                                    licenseHealth.data.dunning.suspended_count > 0
                                        ? 'error'
                                        : 'tertiary'
                                }
                            />
                        </>
                    ) : null}
                    <NoteRow>
                        Activating or replacing a licence key is done in the web app — it is a long
                        JWT that gets pasted, not typed.
                    </NoteRow>
                </Group>

                {isOrgAdmin ? (
                    <Group title="People">
                        {members.isLoading ? (
                            <NoteRow>
                                <ListSkeleton rows={2} />
                            </NoteRow>
                        ) : (
                            <>
                                <InfoRow
                                    label="Members"
                                    value={String(members.data?.length ?? 0)}
                                />
                                <InfoRow
                                    label="Administrators"
                                    value={String(admins.length)}
                                    tone={admins.length === 0 ? 'warning' : 'tertiary'}
                                />
                            </>
                        )}
                        <SettingRow
                            label="Members and roles"
                            icon={
                                <Feather name="users" size={16} color={theme.colors.textSecondary} />
                            }
                            onPress={() => router.push('/org/members')}
                        />
                        <SettingRow
                            label="Privacy Shield"
                            icon={
                                <Feather
                                    name="shield"
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            }
                            onPress={() => router.push('/org/privacy')}
                        />
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
                ) : null}

                {isSuperAdmin ? (
                    <Group
                        title="Platform modules"
                        footer="Importing, updating and removing a module reshapes the whole instance and is a web-app action. This is the health view."
                    >
                        {modules.isLoading ? (
                            <NoteRow>
                                <ListSkeleton rows={3} />
                            </NoteRow>
                        ) : modules.data && modules.data.length > 0 ? (
                            <>
                                <InfoRow label="Installed" value={String(modules.data.length)} />
                                <InfoRow
                                    label="Needing attention"
                                    value={String(brokenModules.length)}
                                    tone={brokenModules.length > 0 ? 'error' : 'success'}
                                />
                                {brokenModules.map((module) => (
                                    <View
                                        key={module.moduleId}
                                        style={{
                                            paddingHorizontal: theme.spacing.lg,
                                            paddingVertical: theme.spacing.md,
                                            gap: 2,
                                        }}
                                    >
                                        <View
                                            style={{
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                gap: theme.spacing.sm,
                                            }}
                                        >
                                            <Text variant="body" style={{ flex: 1 }}>
                                                {module.moduleId}
                                            </Text>
                                            <Badge
                                                label={
                                                    module.restartAdvised
                                                        ? 'Restart advised'
                                                        : `${module.crashesInWindow} crashes`
                                                }
                                                tone="error"
                                            />
                                        </View>
                                        {module.lastActivationError ? (
                                            <Text variant="caption" tone="error" numberOfLines={3}>
                                                {module.lastActivationError}
                                            </Text>
                                        ) : null}
                                    </View>
                                ))}
                            </>
                        ) : (
                            <NoteRow>No platform modules are installed.</NoteRow>
                        )}
                    </Group>
                ) : null}

                <Group title="Maintenance">
                    <InfoRow
                        label="Window"
                        value={window?.active ? 'Announced' : 'None'}
                        tone={window?.active ? 'warning' : 'success'}
                    />
                    {window?.startedAt ? (
                        <InfoRow label="Started" value={relativeTime(window.startedAt)} />
                    ) : null}
                    <NoteRow>
                        Deploy windows are announced by the release pipeline with a deploy token,
                        not from a user session — so there is nothing to trigger here. Open sessions
                        get a warning and an estimate instead of a stream that simply dies.
                    </NoteRow>
                </Group>

                <Group title="Not on a phone">
                    <NoteRow>
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="body">What belongs on a desktop</Text>
                            <Text variant="caption" tone="tertiary">
                                Model and provider configuration, guardrail policies and term
                                libraries, SSO, module import and rollback, licence activation, the
                                compliance evidence pack and the support inbox. Each needs a wide
                                table or a long form, and several are irreversible. The web app has
                                all of them.
                            </Text>
                        </View>
                    </NoteRow>
                </Group>
            </ScrollView>
        </Screen>
    );
}

/** `/api/guard/health` answers one of three shapes, none of them an error. */
function guardLabel(status: string | undefined): string {
    if (!status) return 'Unknown';
    if (status === 'not-configured') return 'Not installed';
    if (status === 'unavailable') return 'Unreachable';
    return humanise(status);
}

function guardTone(status: string | undefined): 'success' | 'warning' | 'error' | 'neutral' {
    if (status === 'ok' || status === 'healthy') return 'success';
    if (status === 'unavailable') return 'error';
    if (status === 'not-configured') return 'neutral';
    return 'warning';
}

/** Inside thirty days is close enough that an admin should act now. */
function expiringSoon(expiresAt: string): boolean {
    const at = new Date(expiresAt).getTime();
    if (Number.isNaN(at)) return false;
    return at - Date.now() < 30 * 24 * 60 * 60 * 1000;
}

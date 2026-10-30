import { useCallback, useMemo } from 'react';
import {
    useAppPasswordStatusQuery, useGithubStatusQuery, useLinkedinStatusQuery, useMemoryStatsQuery,
    useSettingsAgentsQuery, useSettingsOrganizationsQuery, useUserSettingsQuery,
} from '@/api/queries/shellReads';
import type { MemoryStats } from '@/components/knowledge/memory/memoryTypes';
import type { PreferencesAgent } from '../PreferencesSection.types';
import type { SettingsStatuses, SettingsUser } from './settingsShellTypes';

type StatsStatus = 'loading' | 'ok' | 'error';

const NO_AGENTS: PreferencesAgent[] = [];

const BASE_STATUSES: SettingsStatuses = {
    hasFirefliesKey: false, hasYouTrackConfig: false, hasGammaKey: false, hasAfasConfig: false,
    hasVplanConfig: false, hasFirebirdConfig: false, hasScalewayBillingConfig: false,
    hasNmbrsConfig: false, nmbrsApiMode: 'soap', nmbrsSubdomain: '', nmbrsEmail: '', nmbrsEnv: 'production',
    hasSignRequestConfig: false,
    linkedInConnected: false, linkedInName: null, hasLinkedInConfig: false,
    hasNextcloudAppPassword: false, isNextcloudUser: false,
    githubConnected: false,
};

type UserSettingsData = Record<string, unknown> & { nmbrsApiMode?: string; nmbrsSubdomain?: string; nmbrsEmail?: string; nmbrsEnv?: string };

/** The statuses from their four sources, each merged over the defaults: one source failing leaves its fields at the default. */
function mergeStatuses(
    data: UserSettingsData | null | undefined,
    linkedin: { connected?: boolean; name?: string | null } | null | undefined,
    nextcloud: { hasAppPassword?: boolean; isNextcloudUser?: boolean; nextcloudUrl?: string } | null | undefined,
    github: { connected?: boolean } | null | undefined,
): SettingsStatuses {
    let next = BASE_STATUSES;
    if (data) {
        next = {
            ...next, hasFirefliesKey: !!data.hasFirefliesKey, hasYouTrackConfig: !!data.hasYouTrackConfig, hasSignRequestConfig: !!data.hasSignRequestConfig,
            hasGammaKey: !!data.hasGammaKey, hasAfasConfig: !!data.hasAfasConfig, hasVplanConfig: !!data.hasVplanConfig, hasFirebirdConfig: !!data.hasFirebirdConfig,
            hasScalewayBillingConfig: !!data.hasScalewayBillingConfig, hasNmbrsConfig: !!data.hasNmbrsConfig,
            nmbrsApiMode: data.nmbrsApiMode || 'soap', nmbrsSubdomain: data.nmbrsSubdomain || '', nmbrsEmail: data.nmbrsEmail || '',
            nmbrsEnv: data.nmbrsEnv || 'production', hasLinkedInConfig: !!data.hasLinkedInConfig,
        };
    }
    if (linkedin) next = { ...next, linkedInConnected: !!linkedin.connected, linkedInName: linkedin.name ?? null };
    if (nextcloud) next = { ...next, hasNextcloudAppPassword: !!nextcloud.hasAppPassword, isNextcloudUser: !!nextcloud.isNextcloudUser, nextcloudUrl: nextcloud.nextcloudUrl || '' };
    if (github) next = { ...next, githubConnected: !!github.connected };
    return next;
}

/** The memory counters, the agent list, the integration statuses and whether the org has locked its sign-in method. */
export function useSettingsData(user: SettingsUser | null | undefined, canSeeOrg: boolean) {
    const memory = useMemoryStatsQuery<MemoryStats>();
    // loading | ok | error - MemorySection must never paint a zero for a
    // pending or failed fetch (see its header comment). A refetch with stats
    // already on screen (after import, after the panel closes) updates
    // silently; only a first load or a retry after an error shows the placeholder.
    const memoryStatsStatus: StatsStatus = memory.isSuccess ? 'ok' : (memory.isFetching || !memory.isError ? 'loading' : 'error');
    const agents = useSettingsAgentsQuery<PreferencesAgent>().data ?? NO_AGENTS;

    const userSettings = useUserSettingsQuery<UserSettingsData>();
    const linkedin = useLinkedinStatusQuery<{ connected?: boolean; name?: string | null }>();
    const nextcloud = useAppPasswordStatusQuery<{ hasAppPassword?: boolean; isNextcloudUser?: boolean; nextcloudUrl?: string }>();
    // GitHub Sync menu item is hidden until the org-admin connects a GitHub
    // account in Settings -> Connections.
    const github = useGithubStatusQuery<{ connected?: boolean }>();
    const statuses = useMemo(
        () => mergeStatuses(userSettings.data, linkedin.data, nextcloud.data, github.data),
        [userSettings.data, linkedin.data, nextcloud.data, github.data],
    );
    const { refetch: refetchUserSettings } = userSettings;
    const { refetch: refetchLinkedin } = linkedin;
    const { refetch: refetchNextcloud } = nextcloud;
    const { refetch: refetchGithub } = github;
    const fetchSettingsStatuses = useCallback(async () => {
        await Promise.all([refetchUserSettings(), refetchLinkedin(), refetchNextcloud(), refetchGithub()]);
    }, [refetchUserSettings, refetchLinkedin, refetchNextcloud, refetchGithub]);

    // Whether this org has already locked in its sign-in method. Once locked,
    // the "Sign-in Method" sidebar entry is hidden - the panel is a one-time
    // choice and adds no value after the fact.
    const orgs = useSettingsOrganizationsQuery<{ id?: string; authMethod?: string | null }>(canSeeOrg).data;
    const myOrg = user?.organizationId ? orgs?.find(o => o.id === user.organizationId) : orgs?.[0];
    const orgAuthLocked = canSeeOrg && !!myOrg?.authMethod;

    const { refetch: refetchMemory } = memory;
    const fetchMemoryStats = useCallback(async () => { await refetchMemory(); }, [refetchMemory]);

    return { memoryStats: memory.data ?? null, memoryStatsStatus, agents, statuses, orgAuthLocked, fetchMemoryStats, fetchSettingsStatuses };
}

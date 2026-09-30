/**
 * The organisation a screen works on, and the sections this session is
 * offered. Every org section screen starts from `useOrgContext()`: the org id
 * is the session's own (`user.organizationId`), as on the web, where every
 * org-admin panel resolves to the caller's organisation.
 */

import { useQuery } from '@tanstack/react-query';

import { useAccess } from '@/core/access';
import { useAuth } from '@/core/auth/AuthProvider';

import { useOrganization } from './queries';
import { getGithubConnected } from '../api/endpoints';
import { orgKeys } from '../api/keys';
import { inputsFromAccess, visibleOrgSections } from '../model/visibility';

export interface OrgContext {
    orgId: string | null;
    isOrgAdmin: boolean;
    isSelfHosted: boolean;
    isNcOrg: boolean;
}

export function useOrgContext(): OrgContext {
    const { user } = useAuth();
    const access = useAccess();
    return {
        orgId: user?.organizationId ?? null,
        isOrgAdmin: access.isOrgAdmin,
        isSelfHosted: access.mode === 'self-hosted',
        isNcOrg: Boolean(user?.ncOrg),
    };
}

/** Only an org admin is asked: the web hides GitHub Sync from everyone else first. */
function useGithubConnected(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.githubConnected,
        queryFn: ({ signal }) => getGithubConnected(signal),
        enabled,
        staleTime: 5 * 60_000,
        retry: false,
    });
}

export function useOrgSections() {
    const { user } = useAuth();
    const access = useAccess();
    const orgId = user?.organizationId ?? null;
    const org = useOrganization(access.isOrgAdmin ? orgId : null);
    const github = useGithubConnected(access.isOrgAdmin);
    const inputs = inputsFromAccess(access, {
        isNcOrg: Boolean(user?.ncOrg),
        provider: user?.provider,
        authLocked: Boolean(org.data?.authMethod),
        githubConnected: github.data === true,
    });
    return { sections: visibleOrgSections(inputs), org, refetch: () => Promise.all([org.refetch(), github.refetch()]) };
}

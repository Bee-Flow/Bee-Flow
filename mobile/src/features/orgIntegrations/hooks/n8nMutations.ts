/** Writes for the n8n settings. None retries; each refreshes what it changed. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { integrationKeys } from '../api/keys';
import {
    createGroupWithPermission,
    discoverN8nWorkflows,
    enableN8nForOrg,
    saveN8nConfig,
    saveN8nWorkflows,
    setN8nPermission,
    testN8n,
    type N8nCredentials,
} from '../api/n8n';
import { serializeWorkflow } from '../model/n8n';
import type { N8nConfig, N8nWorkflow } from '../model/n8nTypes';

/**
 * The group lists other screens hold (features/org orgKeys.groups and the
 * shared picker's ORG_GROUPS_KEY under ['org', 'groups'], orgPeople's own),
 * written out here: a group created from n8n has to show up there too.
 */
const GROUP_LISTS = [['org', 'groups'], ['orgPeople', 'groups']] as const;

export function useSaveN8nConfig() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: N8nCredentials) => saveN8nConfig(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.n8n.all }),
    });
}

export function useTestN8n() {
    return useMutation({ mutationFn: (body: N8nCredentials) => testN8n(body) });
}

export function useDiscoverN8n() {
    return useMutation({ mutationFn: () => discoverN8nWorkflows() });
}

/** Stores the whole list; the cached config takes it at once. */
export function useSaveN8nWorkflows() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (workflows: N8nWorkflow[]) => saveN8nWorkflows(workflows.map(serializeWorkflow)),
        onSuccess: (_result, workflows) =>
            queryClient.setQueryData<N8nConfig>(integrationKeys.n8n.config, (old) => (old ? { ...old, workflows } : old)),
    });
}

export function useEnableN8nForOrg() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => enableN8nForOrg(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.n8n.diagnostics }),
    });
}

export function useSetN8nPermission() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: { permission: string; groupId: string; action: 'add' | 'remove' }) => setN8nPermission(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.n8n.permissions }),
    });
}

export function useCreateN8nGroup() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ name, permission }: { name: string; permission: string }) => createGroupWithPermission(name, permission),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: integrationKeys.n8n.permissions });
            for (const key of GROUP_LISTS) void queryClient.invalidateQueries({ queryKey: key });
        },
    });
}

// The two reads behind Studio → Skills: the list (`GET /api/skills`, through
// skillsApi so a refusal is an error, not "no skills") and the usage summary.
// Keyed under skillKeys.all, so a skill created or deleted elsewhere refreshes
// this list too.

import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/shared/Toast';
import { skillsApi } from '@/api/skillsApi';
import { skillKeys } from '@/api/queries/skills';
import type { Skill, UsageSummaryMap } from './skillModel.types';

const listKey = [...skillKeys.all, 'studio', 'list'] as const;
const summaryKey = [...skillKeys.all, 'studio', 'usageSummary'] as const;
const NO_SKILLS: Skill[] = [];

function editList(queryClient: QueryClient, edit: (rows: Skill[]) => Skill[]) {
    queryClient.setQueryData<Skill[]>(listKey, (prev) => edit(prev ?? NO_SKILLS));
}

/**
 * `listErrorText` is the toast's fallback text. A failed list read is its own
 * state (`listError`, the rows empty), not an empty list; an unknown usage
 * count is null, which renders as nothing rather than zero.
 */
export function useSkillsStudioData(listErrorText: string) {
    const queryClient = useQueryClient();
    const list = useQuery<Skill[]>({
        queryKey: listKey,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                const rows = await skillsApi.list();
                return Array.isArray(rows) ? rows : [];
            } catch (e) {
                toast.error((e as Error).message || listErrorText);
                throw new Error((e as Error)?.message || 'error', { cause: e });
            }
        },
    });
    const summary = useQuery<UsageSummaryMap | null>({
        queryKey: summaryKey,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                const body = await skillsApi.usageSummary();
                return body?.summary || {};
            } catch {
                return null;
            }
        },
    });
    const { refetch: refetchList } = list;
    const { refetch: refetchSummary } = summary;
    const load = useCallback(async () => { await refetchList(); }, [refetchList]);
    const loadSummary = useCallback(() => { void refetchSummary(); }, [refetchSummary]);
    const patchSkill = useCallback((patch: { id: string }) => {
        editList(queryClient, (rows) => rows.map(s => (s.id === patch.id ? { ...s, ...patch } : s)));
    }, [queryClient]);
    const dropSkill = useCallback((id: string) => {
        editList(queryClient, (rows) => rows.filter(s => s.id !== id));
    }, [queryClient]);

    return {
        skills: list.isError ? NO_SKILLS : list.data ?? NO_SKILLS,
        summary: summary.data ?? null,
        loading: list.isFetching,
        listError: list.error ? list.error.message : null,
        load, loadSummary, patchSkill, dropSkill,
    };
}

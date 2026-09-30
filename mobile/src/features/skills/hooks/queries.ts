/** Skill queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getSkill, getSkillUsage, getSkillUsageSummary, listSkills } from '../api/endpoints';
import { skillKeys } from '../api/keys';
import { listTestAgents, listTestRuns } from '../api/testEndpoints';
import { retainExistingSkills } from '../model/active';

/**
 * The library. On every SUCCESSFUL load it also forgets switched-on skills
 * the library no longer returns — deleted on the web, or shared with a group
 * this person has left. A failed fetch is not evidence that anything is gone.
 */
export function useSkills() {
    const query = useQuery({
        queryKey: skillKeys.list,
        queryFn: ({ signal }) => listSkills(signal),
    });
    const { isSuccess, data } = query;
    useEffect(() => {
        if (!isSuccess || !data) return;
        retainExistingSkills(data.map((s) => s.id));
    }, [isSuccess, data]);
    return query;
}

export function useSkill(id: string) {
    return useQuery({
        queryKey: skillKeys.detail(id),
        queryFn: ({ signal }) => getSkill(id, signal),
        enabled: Boolean(id),
    });
}

/** Counts per skill for the list's subline. A failure leaves every subline blank, never "not linked". */
export function useSkillUsageSummary() {
    return useQuery({
        queryKey: skillKeys.usageSummary,
        queryFn: ({ signal }) => getSkillUsageSummary(signal),
        retry: false,
    });
}

export function useSkillUsage(id: string) {
    return useQuery({
        queryKey: skillKeys.usage(id),
        queryFn: ({ signal }) => getSkillUsage(id, signal),
        enabled: Boolean(id),
    });
}

/** The agents a test may run as — the picker AND the server's own allow-list. */
export function useTestAgents(enabled: boolean) {
    return useQuery({
        queryKey: skillKeys.testAgents,
        queryFn: ({ signal }) => listTestAgents(signal),
        enabled,
        retry: false,
    });
}

/** The last 20 runs. A 403 is the answer "you may look, not test" — not a failure to retry. */
export function useTestRuns(id: string, enabled: boolean) {
    return useQuery({
        queryKey: skillKeys.testRuns(id),
        queryFn: ({ signal }) => listTestRuns(id, signal),
        enabled: enabled && Boolean(id),
        retry: false,
    });
}

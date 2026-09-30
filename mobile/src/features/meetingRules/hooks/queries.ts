/** The rules' reads and the one write. Screens call these, never useQuery. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createMeetingRule, getRunFacets, listMeetingRules } from '../api/endpoints';
import { ruleKeys as keys } from '../api/keys';

/** A licence refusal is an answer, not a blip: no retry. */
export function useMeetingRules() {
    return useQuery({ queryKey: keys.rules, queryFn: ({ signal }) => listMeetingRules(signal), retry: false });
}

export function useRuleRunFacets() {
    return useQuery({ queryKey: keys.facets, queryFn: ({ signal }) => getRunFacets(signal), retry: false });
}

export function useCreateMeetingRule() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ title, description }: { title: string; description: string }) =>
            createMeetingRule(title, description),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.rules }),
    });
}

/**
 * The declared output of every AI step's leading skill in a definition, for
 * the upstream describers (`catalog.skillOutputs`, core aiSteps.mjs).
 *
 * An AI step without a schema of its own answers in its leading skill's
 * shape (server aiStepSkills.js effectiveOutputSchema), so a step after it
 * can pick those fields before any run, but only when the builder knows
 * them. The skill reads share their cache with the step's own "Continues as"
 * list (agentStepKeys.skill), so nothing is fetched twice.
 *
 * Outside a QueryClientProvider (a stand-alone form, most tests) nothing is
 * fetched and the map is empty: the step then offers its whole answer, as
 * before.
 */
import { QueryClient, QueryClientContext, useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useContext } from 'react';
import { leadSkillId } from '@shared/mapping/index.mjs';
import { agentStepKeys, fetchCatalogSkill, type CatalogSkill } from '../../../../api/queries/automation/agents';

interface StepLike { type?: string; skillIds?: unknown; body?: unknown }
interface DefinitionLike { steps?: StepLike[] | null }

export type SkillOutputs = Record<string, { outputFields: CatalogSkill['outputFields'] }>;

// Never used to fetch (every query below is disabled without a provider);
// it only lets the hook run unconditionally.
const IDLE_CLIENT = new QueryClient();

/** The leading skill ids of the AI steps in a definition, loop bodies included. */
export function leadSkillIds(definition: DefinitionLike | null | undefined): string[] {
    const ids = new Set<string>();
    const visit = (steps: unknown) => {
        for (const s of (Array.isArray(steps) ? steps : []) as StepLike[]) {
            if (s?.type === 'ai_step') {
                const id = leadSkillId(s);
                if (id) ids.add(id);
            }
            if (Array.isArray(s?.body)) visit(s.body);
        }
    };
    visit(definition?.steps);
    return [...ids].sort();
}

function combine(results: UseQueryResult<CatalogSkill, Error>[]): SkillOutputs | null {
    const out: SkillOutputs = {};
    for (const r of results) {
        if (r.data && r.data.outputFields.length) out[r.data.id] = { outputFields: r.data.outputFields };
    }
    return Object.keys(out).length ? out : null;
}

export default function useSkillOutputs(definition: DefinitionLike | null | undefined): SkillOutputs | null {
    const client = useContext(QueryClientContext);
    const ids = leadSkillIds(definition);
    return useQueries({
        queries: ids.map(id => ({
            queryKey: agentStepKeys.skill(id),
            queryFn: ({ signal }: { signal: AbortSignal }) => fetchCatalogSkill(id, signal),
            enabled: !!client,
            staleTime: 60_000,
            retry: false,
        })),
        combine,
    }, client ?? IDLE_CLIENT);
}

/**
 * The skill rows one prompt injection works on (core/tools/skillInjection.js
 * buildSkillInjection): the caller's preloaded rows, kept to the merged ids
 * in the caller's order, or a fresh read as the asker may see them, minus an
 * agent-only skill that no agent brought in (./agentOnlySkills.mts).
 *
 * null when the read failed: the caller answers with an empty injection, a
 * broken lookup must not cost the turn.
 */
import { createRequire } from 'node:module';
import { keepUsableSkills, type AgentOnlyAware } from './agentOnlySkills.mts';

const nodeRequire = createRequire(import.meta.url);

type SkillRow = AgentOnlyAware & Record<string, unknown>;

interface SkillReader { getSkillsByIds: (ids: string[], orgId: string, userId: string) => Promise<SkillRow[]> }
interface Logger { warn: (...args: unknown[]) => void }

export interface InjectionSkillsArgs {
    mergedIds: string[];
    preloadedSkills?: readonly (SkillRow | null | undefined)[] | null;
    orgId: string;
    userId: string;
    /** The ids an agent brings in this turn: where an agent-only skill counts. */
    agentIds: readonly string[];
}

export async function injectionSkills<T extends SkillRow = SkillRow>({ mergedIds, preloadedSkills = null, orgId, userId, agentIds }: InjectionSkillsArgs): Promise<T[] | null> {
    let skills: SkillRow[];
    if (Array.isArray(preloadedSkills)) {
        // Rows the caller already loaded with loadSkillsForIds (same ids, same
        // org and asker), so one AI step does not read the same skills twice.
        const wanted = new Set(mergedIds);
        skills = preloadedSkills.filter((s): s is SkillRow => !!s && wanted.has(s.id));
    } else {
        // Required per call, not at load: the store sits in the server's large
        // import cycle, and a suite stubs it in require.cache before this runs.
        const store = nodeRequire('../../stores/skillStore') as SkillReader;
        try {
            skills = (await store.getSkillsByIds(mergedIds, orgId, userId)) || [];
        } catch (err) {
            (nodeRequire('../../telemetry/log') as Logger).warn('[skillInjection] getSkillsByIds failed:', (err as Error).message);
            return null;
        }
    }
    return keepUsableSkills(skills, agentIds) as T[];
}

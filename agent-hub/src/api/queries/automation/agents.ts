// Agents and skills inside an AI step (handoff 5, round 3).
//
// The ONLY place that knows these wire contracts:
//   GET /api/automation/catalog/agent/:id   what an agent brings to one step
//   GET /api/automation/catalog/skill/:id   a skill's output fields
//   GET /api/skills                          the skills a step can add
// so a server change is adjusted here and nowhere else.
//
// `authFetch` rather than `apiClient`: every one of these reads has a "could
// not be read" state the editor renders as a sentence, never as an empty list,
// and the tests mock `authFetch` with a bare `{ ok, status, json }`.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';

export interface AgentPermissions {
    startAutomations: boolean;
    useKnowledge: boolean;
    useTools: boolean;
}

export const AGENT_PERMISSION_KEYS: ReadonlyArray<keyof AgentPermissions> = ['startAutomations', 'useKnowledge', 'useTools'];

/** One integration's tools as the agent would bring them to this step. */
export interface AgentToolGroup {
    integration: string;
    label: string;
    tools: string[];
    withheld: boolean;
    reason: string | null;
}

export interface AgentSkillRef { id: string; name: string; fromAgent: boolean }
export interface NamedRef { id: string; name: string }
export interface WithheldTool { name: string; reason: string }

/** GET /catalog/agent/:id, normalised. Absent lists stay null (unknown), never []. */
export interface AgentStepPreview {
    id: string;
    canUse: boolean;
    name: string | null;
    version: number | null;
    scope: 'org' | 'personal' | null;
    runtimeSource: string | null;
    knowledgeBases: NamedRef[] | null;
    skills: AgentSkillRef[] | null;
    tools: AgentToolGroup[] | null;
    allowed: string[];
    withheld: WithheldTool[];
    degraded: boolean;
    error: string | null;
}

export interface SkillOutputField { key: string; type: string; title: string | null }

/** GET /catalog/skill/:id (or a /api/skills row), normalised. */
export interface CatalogSkill {
    id: string;
    name: string;
    version: number | null;
    outputFields: SkillOutputField[];
}

export interface SkillRow { id: string; name: string; description: string | null }

export const agentStepKeys = {
    all: ['automation-agent-step'] as const,
    preview: (agentId: string, perms: string, tools: string | null, skills = '', disabled = '') =>
        ['automation-agent-step', 'preview', agentId, perms, tools, skills, disabled] as const,
    skill: (skillId: string) => ['automation-agent-step', 'skill', skillId] as const,
    skills: () => ['automation-agent-step', 'skills'] as const,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** A list of `{id,name}` (or bare ids/names); null when the key is absent. */
function namedList(v: unknown): NamedRef[] | null {
    if (!Array.isArray(v)) return null;
    const out: NamedRef[] = [];
    for (const item of v) {
        if (typeof item === 'string' && item) { out.push({ id: item, name: item }); continue; }
        const o = obj(item);
        const id = o && (str(o.id) || str(o.name));
        if (o && id) out.push({ id, name: str(o.name) || str(o.title) || id });
    }
    return out;
}

/** Normalise one preview body. Exported for the test; tolerant of an older server. */
export function parseAgentStepPreview(body: unknown, agentId: string): AgentStepPreview {
    const raw = obj(body) || {};
    const skills = Array.isArray(raw.skills)
        ? raw.skills.flatMap((s): AgentSkillRef[] => {
            const o = obj(s);
            const id = o && str(o.id);
            // `fromAgent` absent reads as true: this endpoint describes the agent.
            return o && id ? [{ id, name: str(o.name) || id, fromAgent: o.fromAgent !== false }] : [];
        })
        : null;
    const tools = Array.isArray(raw.tools)
        ? raw.tools.flatMap((g): AgentToolGroup[] => {
            const o = obj(g);
            const integration = o && (str(o.integration) || str(o.label));
            if (!o || !integration) return [];
            return [{
                integration,
                label: str(o.label) || integration,
                tools: strings(o.tools),
                withheld: o.withheld === true,
                reason: str(o.reason),
            }];
        })
        : null;
    const withheld = Array.isArray(raw.withheld)
        ? raw.withheld.flatMap((w): WithheldTool[] => {
            if (typeof w === 'string' && w) return [{ name: w, reason: 'unavailable' }];
            const o = obj(w);
            const name = o && str(o.name);
            return o && name ? [{ name, reason: str(o.reason) || 'unavailable' }] : [];
        })
        : [];
    const scope = raw.scope === 'org' || raw.scope === 'personal' ? raw.scope : null;
    return {
        id: str(raw.id) || agentId,
        canUse: raw.canUse !== false,
        name: str(raw.name),
        version: num(raw.version),
        scope,
        runtimeSource: str(raw.runtimeSource),
        knowledgeBases: namedList(raw.knowledgeBases),
        skills,
        tools,
        allowed: strings(raw.allowed),
        withheld,
        degraded: raw.degraded === true,
        error: str(raw.error),
    };
}

/** The permissions as the `1`/`0` string the key and the query both use. */
export function permissionBits(p: Partial<AgentPermissions> | null | undefined): string {
    return AGENT_PERMISSION_KEYS.map((k) => (p?.[k] === true ? '1' : '0')).join('');
}

/** The step's own skills and the agent skills it switched off; both change what the run is granted. */
export interface AgentStepSkillScope {
    skillIds?: string[];
    disabledAgentSkillIds?: string[];
}

const idListParam = (key: string, ids: string[] | undefined): string => (
    Array.isArray(ids) && ids.length > 0 ? `&${key}=${encodeURIComponent(ids.join(','))}` : '');

export async function fetchAgentStepPreview(
    agentId: string, perms: string, tools: string[] | null, signal?: AbortSignal, scope: AgentStepSkillScope = {},
): Promise<AgentStepPreview> {
    const q = AGENT_PERMISSION_KEYS.map((k, i) => `${k}=${perms[i] === '1' ? '1' : '0'}`).join('&');
    // Absent `tools` = the author set no allowlist; `tools=` (empty) = an empty
    // one, which means NO tools. The two stay apart on the wire.
    const tq = Array.isArray(tools) ? `&tools=${encodeURIComponent(tools.join(','))}` : '';
    // The skills the step runs with grant apps and automations of their own, so the
    // tool groups only match the run when the server knows which skills those are.
    const sq = idListParam('skillIds', scope.skillIds) + idListParam('disabledAgentSkillIds', scope.disabledAgentSkillIds);
    const res = await authFetch(`${API_BASE}/api/automation/catalog/agent/${encodeURIComponent(agentId)}?${q}${tq}${sq}`, { signal });
    if (!res.ok) throw new Error(`agent preview ${res.status}`);
    return parseAgentStepPreview(await res.json(), agentId);
}

/**
 * What the chosen agent brings to this step, asked with the switches as they
 * stand: the answer differs per combination, and a stale one is a wrong one.
 */
export function useAgentStepPreviewQuery(
    agentId: string | null, permissions: Partial<AgentPermissions> | null | undefined, allowList: string[] | null,
    scope: AgentStepSkillScope = {},
) {
    const bits = permissionBits(permissions);
    const toolsKey = Array.isArray(allowList) ? allowList.join(',') : null;
    const skillsKey = (scope.skillIds || []).join(',');
    const disabledKey = (scope.disabledAgentSkillIds || []).join(',');
    return useQuery<AgentStepPreview, Error>({
        queryKey: agentStepKeys.preview(agentId || '', bits, toolsKey, skillsKey, disabledKey),
        queryFn: ({ signal }) => fetchAgentStepPreview(agentId as string, bits, allowList, signal, scope),
        // Flipping a switch or a skill asks again; the same agent's last answer
        // stays on screen meanwhile. Another agent's answer never does.
        placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === agentId ? prev : undefined),
        enabled: !!agentId,
        staleTime: 30_000,
        retry: false,
    });
}

const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'datetime', 'object', 'array']);

/** Output fields from `outputFields` rows or a JSON-schema `output_schema`. */
export function skillOutputFields(raw: Obj): SkillOutputField[] {
    if (Array.isArray(raw.outputFields)) {
        return raw.outputFields.flatMap((f): SkillOutputField[] => {
            const o = obj(f);
            const key = o && (str(o.key) || str(o.name));
            if (!o || !key) return [];
            const type = str(o.type) || 'string';
            return [{ key, type: FIELD_TYPES.has(type) ? type : 'string', title: str(o.title) || str(o.label) }];
        });
    }
    const schema = obj(raw.output_schema) || obj(raw.outputSchema);
    const props = schema && obj(schema.properties);
    if (!props) return [];
    return Object.entries(props).map(([key, def]) => {
        const d = obj(def) || {};
        const type = str(d.type) || 'string';
        const isDate = type === 'string' && (d.format === 'date' || d.format === 'date-time');
        return { key, type: isDate ? 'datetime' : (FIELD_TYPES.has(type) ? type : 'string'), title: str(d.title) };
    });
}

/** Normalise one skill body. Exported for the test. */
export function parseCatalogSkill(body: unknown, skillId: string): CatalogSkill {
    const raw = obj(body) || {};
    return {
        id: str(raw.id) || skillId,
        name: str(raw.name) || skillId,
        version: num(raw.version) ?? num(raw.published_version),
        outputFields: skillOutputFields(raw),
    };
}

export async function fetchCatalogSkill(skillId: string, signal?: AbortSignal): Promise<CatalogSkill> {
    const res = await authFetch(`${API_BASE}/api/automation/catalog/skill/${encodeURIComponent(skillId)}`, { signal });
    if (!res.ok) throw new Error(`skill ${res.status}`);
    return parseCatalogSkill(await res.json(), skillId);
}

/** The leading skill's contract: its name, version and the fields the step inherits. */
export function useCatalogSkillQuery(skillId: string | null) {
    return useQuery<CatalogSkill, Error>({
        queryKey: agentStepKeys.skill(skillId || ''),
        queryFn: ({ signal }) => fetchCatalogSkill(skillId as string, signal),
        enabled: !!skillId,
        staleTime: 60_000,
        retry: false,
    });
}

/** Normalise the /api/skills list. Exported for the test. */
export function parseSkillRows(body: unknown): SkillRow[] {
    const list = Array.isArray(body) ? body : (obj(body)?.skills as unknown[] | undefined) || [];
    return list.flatMap((s): SkillRow[] => {
        const o = obj(s);
        const id = o && str(o.id);
        return o && id ? [{ id, name: str(o.name) || id, description: str(o.description) }] : [];
    });
}

export async function fetchStepSkills(signal?: AbortSignal): Promise<SkillRow[]> {
    const res = await authFetch(`${API_BASE}/api/skills`, { signal });
    if (!res.ok) throw new Error(`skills ${res.status}`);
    return parseSkillRows(await res.json());
}

/** Every skill the author can add to a step (names for the step's own skills too). */
export function useStepSkillsQuery(enabled = true) {
    return useQuery<SkillRow[], Error>({
        queryKey: agentStepKeys.skills(),
        queryFn: ({ signal }) => fetchStepSkills(signal),
        enabled,
        staleTime: 60_000,
        retry: false,
    });
}

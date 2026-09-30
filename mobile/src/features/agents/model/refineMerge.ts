/**
 * The "preserve & patch" merge of an AI refine — a port of the web's
 * agent-hub/src/components/agents/AgentWizard/state/refineMerge.js, pinned by
 * refineMerge.lockstep.test.ts (the web module and this port run on the same
 * fixtures).
 *
 *   buildRefineContext(state)  the { plan, current } body of POST /agents/wizard/refine
 *   mergeRefinedPlan(...)      folds the AI's plan into the agent WITHOUT wiping
 *                              curated apps, skills, model or knowledge bases
 *   diffRefinedPlan(a, b)      what the refine ACTUALLY changed — the Done card
 *
 * Golden rule: an absent or empty field keeps the current value. Curated lists
 * are additive on refine; removals are done by hand in the editor.
 *
 * `persona` follows the web exactly: it is the source the server renders the
 * system prompt from, so a refine that rewrites the prompt must carry a
 * matching persona, and an UNREAD persona (undefined) is never overwritten.
 */

import type { AgentConfig } from './types';

export type Persona = Record<string, unknown>;

export interface PersonaFields {
    who: string;
    tone: { chips: string[]; text: string };
    does: string[];
    doesNot: string[];
}

/** The agent as the merge sees it — the editor's draft plus the persona column. */
export interface RefineState {
    name: string;
    description: string;
    systemPrompt: string;
    avatar: string;
    model: string | null;
    config: AgentConfig;
    /** The stored persona; undefined is "not read", which never writes. */
    persona?: Persona | null;
    /** True only before the agent row exists: the one case a fresh persona may be written. */
    noStoredPersona?: boolean;
}

/** The normalised plan the server answers (server/routes/agents/wizard.js normalizePlan). */
export interface RefinedPlan {
    name?: string;
    description?: string;
    avatar?: string;
    systemPrompt?: string;
    capabilities?: string[];
    model?: string | null;
    enabledIntegrations?: string[];
    knowledge_base_ids?: string[];
    skills?: { id: string | null; name: string }[];
    persona?: unknown;
}

export interface Preserved {
    model?: string | null;
    enabledIntegrations?: string[];
    attachedSkillIds?: string[];
    knowledge_base_ids?: string[];
}

export interface MergeOptions {
    availableIntegrationIds?: readonly string[];
    selectableTierKeys?: readonly string[];
    resolvedSkillIds?: readonly string[] | null;
}

export interface RefineChange {
    field: 'systemPrompt' | 'name' | 'description' | 'avatar' | 'model' | 'apps' | 'skills' | 'knowledge';
    direction?: 'added' | 'removed';
    count?: number;
    ids?: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const uniq = (arr: readonly string[]): string[] => Array.from(new Set(arr.filter(Boolean)));

/** The four descriptive persona fields, or null when there is no role. */
export function personaFieldsOf(persona: unknown): PersonaFields | null {
    if (!isObject(persona)) return null;
    const tone = isObject(persona.tone) ? persona.tone : {};
    const fields: PersonaFields = {
        who: str(persona.who),
        tone: { chips: list(tone.chips), text: str(tone.text) },
        does: list(persona.does),
        doesNot: list(persona.doesNot),
    };
    const hasContent = Boolean(
        fields.who || fields.does.length || fields.doesNot.length || fields.tone.chips.length || fields.tone.text,
    );
    return hasContent ? fields : null;
}

/** Does this agent already carry instructions someone wrote themselves? */
export function hasFreeInstruction(state: Partial<RefineState> = {}): boolean {
    const persona = state.persona;
    if (isObject(persona) && persona.mode === 'fields') return false;
    const freeText = isObject(persona) && typeof persona.freeText === 'string' ? persona.freeText : '';
    return Boolean(freeText.trim() || String(state.systemPrompt || '').trim());
}

export interface RefineContextInput {
    name?: string;
    description?: string;
    avatar?: string;
    systemPrompt?: string;
    capabilities?: unknown;
    model?: string | null;
    enabledIntegrations?: unknown;
    attachedSkills?: unknown;
    knowledge_base_ids?: unknown;
    persona?: unknown;
}

/** The { plan, current } portions of the refine request. */
export function buildRefineContext(state: RefineContextInput = {}) {
    const personaFields = personaFieldsOf(state.persona);
    return {
        plan: {
            name: state.name || '',
            description: state.description || '',
            avatar: state.avatar || '',
            systemPrompt: state.systemPrompt || '',
            capabilities: strings(state.capabilities),
            ...(personaFields ? { persona: personaFields } : {}),
        },
        current: {
            model: typeof state.model === 'string' ? state.model : null,
            enabledIntegrations: strings(state.enabledIntegrations),
            attachedSkills: Array.isArray(state.attachedSkills) ? state.attachedSkills : [],
            knowledge_base_ids: strings(state.knowledge_base_ids),
        },
    };
}

interface PersonaInput {
    systemPrompt: string;
    description: string;
    capabilities: string[];
    planPersona: unknown;
}

function describedPersona(base: Persona, input: PersonaInput, fields: PersonaFields | null): Persona {
    if (fields) {
        return {
            ...base,
            who: fields.who || base.who || '',
            does: fields.does,
            doesNot: fields.doesNot,
            tone: fields.tone,
        };
    }
    const baseDoes = Array.isArray(base.does) ? base.does : [];
    return {
        ...base,
        who: input.description || base.who || '',
        does: input.capabilities.length ? input.capabilities : baseDoes,
    };
}

/** The persona after a refine — see the web file's docblock for the three cases. */
function personaAfterRefine(current: Partial<RefineState>, input: PersonaInput): Persona | null | undefined {
    const cur = current.persona;
    if (input.systemPrompt === current.systemPrompt) return cur;
    const readable = isObject(cur);
    if (!readable && current.noStoredPersona !== true) return undefined;
    const base: Persona = readable ? cur : {};
    const fields = personaFieldsOf(input.planPersona);
    const described = describedPersona(base, input, fields);
    if (fields && !hasFreeInstruction(current)) return { ...described, mode: 'fields', freeText: '' };
    return { ...described, mode: 'free', freeText: input.systemPrompt || '' };
}

/** A non-empty list wins; otherwise the preserved echo, otherwise the current value. */
function curated(preserved: unknown, current: unknown): string[] {
    const echo = strings(preserved);
    return echo.length ? echo : strings(current);
}

function mergedModel(current: string | null, planModel: unknown, selectable: readonly string[]): string | null {
    if (typeof planModel !== 'string' || !planModel) return current;
    const tierName = planModel === 'smart' ? 'thinking' : planModel;
    return selectable.includes(tierName) ? `tier:${tierName}` : current;
}

function mergedConfig(curConfig: AgentConfig, updated: RefinedPlan, preserved: Preserved, opts: MergeOptions): AgentConfig {
    const available = opts.availableIntegrationIds ?? [];
    const planApps = strings(updated.enabledIntegrations);
    const enabledIntegrations = planApps.length
        ? planApps.filter((id) => available.includes(id))
        : curated(preserved.enabledIntegrations, curConfig.enabledIntegrations);
    const attachedSkillIds = Array.isArray(opts.resolvedSkillIds)
        ? uniq(opts.resolvedSkillIds)
        : strings(curConfig.attachedSkillIds);
    const planKbs = strings(updated.knowledge_base_ids);
    const knowledge_base_ids = planKbs.length
        ? planKbs
        : curated(preserved.knowledge_base_ids, curConfig.knowledge_base_ids);
    const wizard = isObject(curConfig.wizard) ? curConfig.wizard : {};
    return {
        ...curConfig,
        enabledIntegrations,
        attachedSkillIds,
        knowledge_base_ids,
        wizard: {
            ...wizard,
            capabilities: Array.isArray(updated.capabilities) ? updated.capabilities : strings(wizard.capabilities),
        },
    };
}

export interface MergedAgent {
    name: string;
    description: string;
    systemPrompt: string;
    avatar: string;
    model: string | null;
    config: AgentConfig;
    persona: Persona | null | undefined;
}

/** Fold the AI's plan into the agent's current state; never wipes curated config. */
export function mergeRefinedPlan(
    current: RefineState,
    updated: RefinedPlan = {},
    preserved: Preserved = {},
    opts: MergeOptions = {},
): MergedAgent {
    const name = typeof updated.name === 'string' && updated.name.trim() ? updated.name : current.name;
    const avatar = updated.avatar || current.avatar;
    const description = typeof updated.description === 'string' ? updated.description : current.description;
    const systemPrompt =
        typeof updated.systemPrompt === 'string' && updated.systemPrompt.trim() ? updated.systemPrompt : current.systemPrompt;
    const model = mergedModel(current.model, updated.model, opts.selectableTierKeys ?? []);
    const config = mergedConfig(current.config || {}, updated, preserved, opts);
    const wizard = config.wizard as { capabilities: string[] };
    const persona = personaAfterRefine(current, {
        systemPrompt,
        description,
        capabilities: wizard.capabilities,
        planPersona: updated.persona,
    });
    return { name, description, systemPrompt, avatar, model, config, persona };
}

const LIST_FIELDS = [
    ['apps', 'enabledIntegrations'],
    ['skills', 'attachedSkillIds'],
    ['knowledge', 'knowledge_base_ids'],
] as const;

/** What the refine ACTUALLY changed, as data: the card picks the words. */
export function diffRefinedPlan(before: Partial<MergedAgent> = {}, after: Partial<MergedAgent> = {}): RefineChange[] {
    const changes: RefineChange[] = [];
    const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    for (const field of ['systemPrompt', 'name', 'description', 'avatar', 'model'] as const) {
        if (text(before[field]) !== text(after[field])) changes.push({ field });
    }
    const beforeCfg = before.config || {};
    const afterCfg = after.config || {};
    for (const [field, key] of LIST_FIELDS) {
        const was = strings(beforeCfg[key]);
        const now = strings(afterCfg[key]);
        const added = now.filter((id) => !was.includes(id));
        const removed = was.filter((id) => !now.includes(id));
        if (added.length) changes.push({ field, direction: 'added', count: added.length, ids: added });
        if (removed.length) changes.push({ field, direction: 'removed', count: removed.length, ids: removed });
    }
    return changes;
}

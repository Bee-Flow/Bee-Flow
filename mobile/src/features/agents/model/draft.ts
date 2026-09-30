/**
 * The agent editor's draft — what the web's BuilderSplit keeps in `stateRef`
 * — and the request bodies built from it. Pure; unit-tested in draft.test.ts.
 *
 * THE PUT WRITES WHAT IT IS GIVEN. `PUT /agents/:id` falls back to the stored
 * row only for fields that are absent, so every save sends the full canonical
 * snapshot (name, description, systemPrompt, model, avatar, category,
 * starters, config) plus `baseVersion` — the rev the editor loaded — so a
 * concurrent edit answers 409 instead of being silently overwritten.
 *
 * `persona` is never sent from a manual edit, exactly as the web: an absent
 * persona tells the server to leave the column alone. Only a refine sends one.
 */

import { DEFAULT_AGENT_EMOJI, pickAgentAvatar } from './avatar';
import { parseStarterPrompts } from './format';
import type { Persona } from './refineMerge';
import type { Agent, AgentConfig } from './types';

/** GET /agents/:id?draft=1 — the concept, with the editor-only columns. */
export interface AgentDetail extends Agent {
    system_prompt: string | null;
    /** Only on the draft view with edit rights; undefined means "not read". */
    persona?: Persona | null;
    /** 0 until the first publish-version; then edits wait for the next one. */
    published_version?: number;
    unpublishedChanges?: number;
}

export interface AgentDraft {
    name: string;
    description: string;
    avatar: string;
    systemPrompt: string;
    /** A raw model id or `tier:<key>`; '' is the organisation's default. */
    model: string;
    categoryId: string | null;
    starterPrompts: string[];
    config: AgentConfig;
}

export function emptyDraft(name: string): AgentDraft {
    return {
        name,
        description: '',
        avatar: DEFAULT_AGENT_EMOJI,
        systemPrompt: '',
        model: '',
        categoryId: null,
        starterPrompts: [],
        // What the web's wizard creates: apps off, nothing linked, no memory.
        config: { enabledIntegrations: [], knowledge_base_ids: [], attachedSkillIds: [], memoryEnabled: false },
    };
}

export function draftOf(agent: AgentDetail): AgentDraft {
    return {
        name: agent.name,
        description: agent.description ?? '',
        avatar: pickAgentAvatar(agent) || DEFAULT_AGENT_EMOJI,
        systemPrompt: agent.system_prompt ?? '',
        model: agent.model ?? '',
        categoryId: agent.category_id ?? null,
        starterPrompts: parseStarterPrompts(agent.starter_prompts),
        config: { ...agent.config },
    };
}

const cleanStarters = (list: readonly string[]) => list.map((s) => s.trim()).filter(Boolean);

/** The PUT /agents/:id body. `baseVersion` is omitted when the rev is unknown. */
export function savePayload(draft: AgentDraft, rev?: number, persona?: Persona | null) {
    return {
        name: draft.name.trim(),
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        model: draft.model || null,
        avatar: draft.avatar,
        categoryId: draft.categoryId,
        starterPrompts: cleanStarters(draft.starterPrompts),
        config: { ...draft.config },
        ...(persona !== undefined ? { persona } : {}),
        ...(Number.isInteger(rev) ? { baseVersion: rev } : {}),
    };
}

/** The POST /agents body. The create route reads the picture from `config.avatar`. */
export function createPayload(draft: AgentDraft) {
    return {
        name: draft.name.trim(),
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        model: draft.model || null,
        categoryId: draft.categoryId,
        starterPrompts: cleanStarters(draft.starterPrompts),
        config: { ...draft.config, avatar: draft.avatar },
    };
}

export function sameDraft(a: AgentDraft, b: AgentDraft): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export type DraftErrors = Partial<Record<'name', string>>;

type Translate = (key: string, fallback: string) => string;

/** The server's one hard rule on create and save: an agent has a name. */
export function validateDraft(t: Translate, draft: AgentDraft): DraftErrors {
    if (!draft.name.trim()) return { name: t('mobile.agents.editor.name_required', 'Give the agent a name.') };
    return {};
}

/** Add or drop one id; returns a new list. */
export function toggleId(list: readonly string[] | null | undefined, id: string): string[] {
    const current = list ?? [];
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/** `useGeneralMemory` and `allowCopy` default ON; the rest default off. */
export function configFlag(config: AgentConfig, key: string): boolean {
    const value = config[key];
    if (key === 'useGeneralMemory' || key === 'allowCopy') return value !== false;
    return value === true;
}

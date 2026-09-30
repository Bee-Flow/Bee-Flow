/**
 * Pure presentation logic for agents: what a raw column means to a reader.
 * Unit-tested in format.test.ts.
 */

import type { Agent, AgentComponent, AgentConversationSummary } from './types';

/**
 * `starter_prompts` is a TEXT column of JSON that `parseConfig` does not parse
 * (server/stores/agent/agentCrud.js) — only the public `/embed` endpoint does,
 * inline. So it arrives here as a string on every route this client uses.
 * Blank entries are dropped because the editor keeps empty rows around.
 */
export function parseStarterPrompts(raw: string | string[] | null | undefined): string[] {
    if (!raw) return [];
    const list: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        // A malformed blob must cost this agent its starter prompts, not its row.
        return null;
    }
}

/**
 * Component ids are kebab-case slugs (`web-search`, `http-request`). When the
 * catalogue has not loaded — or the component was removed from the install —
 * a de-slugged id still reads better than the raw one.
 */
export function toolLabel(componentId: string, catalogue: AgentComponent[]): string {
    const match = catalogue.find((c) => c.id === componentId);
    if (match?.name) return match.name;
    return componentId
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** `tier:<key>` is a tier, not a model name; showing the raw string would mean nothing. */
export function describeModel(model: string | null): string {
    if (!model) return 'Your organisation’s default';
    if (model.startsWith('tier:')) {
        const tier = model.slice('tier:'.length).replace(/^custom:/, '').replace(/[-_]+/g, ' ');
        return `Chosen per message — ${tier} tier`;
    }
    return model;
}

/** `favorites` is not a category id — it is a filter over the same list. */
export const FAVORITES = 'favorites';
export const ALL = 'all';

/** The agent list, searched locally: it is tens of rows, not thousands. */
export function filterAgents(
    agents: Agent[],
    search: string,
    category: string,
    favoriteIds: ReadonlySet<string>,
): Agent[] {
    const needle = search.trim().toLowerCase();
    return agents.filter((agent) => {
        if (needle) {
            const haystack = `${agent.name} ${agent.description ?? ''}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        if (category === FAVORITES) return favoriteIds.has(agent.id);
        if (category !== ALL) return agent.category_id === category;
        return true;
    });
}

/**
 * Pinned first, then newest. `listConversations` orders by `updated_at` only
 * (server/stores/agent/agentConversations.js), so pinning has no effect on the
 * wire order and has to be applied here.
 */
export function sortAndFilterConversations(
    items: AgentConversationSummary[],
    search: string,
): AgentConversationSummary[] {
    const needle = search.trim().toLowerCase();
    const filtered = needle
        ? items.filter((item) => (item.title ?? '').toLowerCase().includes(needle))
        : items;
    return filtered.slice().sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
}

/**
 * Memory — what the assistant carries between conversations.
 *
 * Rows come straight off `user_memories` (server/stores/memoryStore.js), so
 * the field names are the column names, snake_case and all. Only the columns
 * this screen actually reads are declared; the table also carries embeddings,
 * supersession pointers and automation-coverage bookkeeping that no phone screen
 * has any business showing.
 */

import { translate } from '@/core/i18n';


export interface Memory {
    id: string;
    user_id: string;
    /** Set when the memory belongs to one agent rather than to the user at large. */
    agent_id: string | null;
    type: string;
    content: string;
    /** A shorter restatement, when one was generated. */
    summary: string | null;
    /** 0..1. The list is ordered by this before recency. */
    importance: number;
    status: string;
    /**
     * Always null in this screen's list: the user-global view filters
     * `project_id IS NULL`, and project memories are a shared team pool with
     * their own access rules. Declared so nothing here can quietly assume
     * every memory is personal.
     */
    project_id: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * GET /agents/memory for the user-global view. The route only returns the
 * paging fields for that view — with an `agentId` or `projectId` it answers a
 * bare `{ memories }` — so api/readers.ts fills them in rather than making every
 * caller handle the optional shape.
 */
export interface MemoryPage {
    memories: Memory[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
}

/** GET /agents/memory/stats. Counts cover everything outside a project. */
export interface MemoryStats {
    total: number;
    /** Parallel arrays. A count the server sent as something other than a number is null. */
    typeDistribution: { labels: string[]; data: (number | null)[] };
    importanceDistribution: { high: number; medium: number; low: number };
}

/**
 * The seven types the server writes, copied from MEMORY_TYPES in
 * server/routes/memory.js. There is a `GET /agents/memory/types` endpoint that
 * returns the same list, but it is a constant in the route file — spending a
 * request on it would buy nothing, and `memoryTypeLabel` already falls back
 * gracefully for a type this list has not heard of (the extractor and the
 * automation bookkeeping can both write ids outside the seven).
 *
 * Ids only. The display name used to sit here as an English literal, which a
 * catalogue arriving after this module is evaluated can never reach — a
 * module constant is read once. It lives in memoryTypeLabel() instead, beside
 * the key it belongs to.
 */
export const MEMORY_TYPES: readonly string[] = [
    'instruction',
    'person',
    'project',
    'preference',
    'workflow',
    'fact',
    'context',
];

/**
 * The web's own keys: the same seven names are already translated for the
 * Memory panel in the browser, so borrowing them means an administrator who
 * has translated one client has translated both.
 */
export function memoryTypeLabel(type: string): string {
    switch (type) {
        case 'instruction':
            return translate('settings.memory_type_instruction', 'Instructions');
        case 'person':
            return translate('settings.memory_type_person', 'People');
        case 'project':
            return translate('settings.memory_type_project', 'Projects');
        case 'preference':
            return translate('settings.memory_type_preference', 'Preferences');
        case 'workflow':
            return translate('settings.memory_type_workflow', 'Workflows');
        case 'fact':
            return translate('settings.memory_type_fact', 'Facts');
        case 'context':
            return translate('settings.memory_type_context', 'Context');
        default:
            // An unknown id is still worth showing — capitalised and
            // de-underscored beats hiding it, because "why does it think
            // that?" needs an answer even when the answer is a type this build
            // has not seen.
            return type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    }
}

/** How much weight the retriever gives a row. Bucketed as the server does. */
export function importanceLabel(importance: number): 'High' | 'Medium' | 'Low' {
    if (importance >= 0.8) return 'High';
    if (importance >= 0.5) return 'Medium';
    return 'Low';
}

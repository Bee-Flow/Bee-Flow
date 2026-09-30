/**
 * Contract readers for /agents/memory (routes/memory.js). Rows come straight
 * off `user_memories`, snake_case and all.
 */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type { Memory, MemoryPage, MemoryStats } from '../model/types';

export const readMemory: (raw: unknown) => Memory = shapeOf({
    id: field.str(''),
    user_id: field.str(''),
    agent_id: field.strOrNull,
    type: field.str(''),
    content: field.str(''),
    summary: field.strOrNull,
    importance: field.num(0),
    status: field.str(''),
    project_id: field.strOrNull,
    created_at: field.str(''),
    updated_at: field.str(''),
});

const readRawPage = shapeOf({
    memories: field.list(readMemory),
    total: field.optNum,
    limit: field.optNum,
    offset: field.optNum,
    hasMore: field.optBool,
});

/**
 * The route only sends the paging fields for the user-global view — with an
 * `agentId` or `projectId` it answers a bare `{ memories }` — so they fall
 * back to what was asked for, and the infinite list has a well-defined
 * stopping point either way.
 */
export function readMemoryPage(raw: unknown, asked: { limit: number; offset: number }): MemoryPage {
    const page = readRawPage(raw);
    return {
        memories: page.memories,
        total: page.total ?? page.memories.length,
        limit: page.limit ?? asked.limit,
        offset: page.offset ?? asked.offset,
        hasMore: page.hasMore ?? false,
    };
}

/** A count that is not a number stays null, so the histogram can skip it. */
export const readMemoryStats: (raw: unknown) => MemoryStats | null = nullable(
    shapeOf({
        total: field.num(0),
        typeDistribution: shapeOf({ labels: field.strArray, data: field.list(field.numOrNull) }),
        importanceDistribution: shapeOf({ high: field.num(0), medium: field.num(0), low: field.num(0) }),
    }),
);

/** POST /agents/memory/bulk-delete answers how many rows actually went. */
export function readDeletedCount(raw: unknown): number {
    return field.num(0)(pick(raw, 'deleted'));
}

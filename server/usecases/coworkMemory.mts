/**
 * What a Cowork task remembers from one run to the next (routes/coworkMemoryRoutes.js): the coverage rows its runs
 * keep (stores/memoryStats.js, the "already surfaced" list a run of an agent with memory reads first). Its owner sees
 * them, clears them (the next run starts fresh), and can undo a clear.
 *
 * The rows are the owner's bookkeeping of their own task: a title or a summary per item, never what a run read.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface CoverageRow { id: string; subject?: string | null; summary?: string | null; value?: string | null; last_confirmed_at?: unknown }

export interface MemoryStore {
    getScheduleCoverage(scheduleId: string, opts?: { limit?: number }): Promise<CoverageRow[]>;
    clearScheduleCoverage(userId: string, scheduleId: string): Promise<string[]>;
    restoreScheduleCoverage(userId: string, scheduleId: string, ids: string[]): Promise<number>;
}

export interface TaskMemory { id: string; text: string; at: string | null }

interface OwnedItem { id: string; userId: string }

const defaultStore = (): MemoryStore => nodeRequire('../stores/memoryStore.js') as MemoryStore;

const LIMIT = 50;

function iso(v: unknown): string | null {
    if (!v) return null;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One row as the owner reads it: its title, else its summary, else its subject. */
function memoryOf(row: CoverageRow): TaskMemory {
    const text = [row.value, row.summary, row.subject].map((v) => (typeof v === 'string' ? v.trim() : '')).find(Boolean) ?? '';
    return { id: String(row.id), text, at: iso(row.last_confirmed_at) };
}

/** What the task remembers, newest first. */
export async function memoriesOf(item: OwnedItem, store: MemoryStore = defaultStore()): Promise<{ memories: TaskMemory[] }> {
    const rows = await store.getScheduleCoverage(item.id, { limit: LIMIT });
    return { memories: rows.map(memoryOf).filter((m) => m.text) };
}

/** Forget it all; the ids that were cleared come back, for Undo. */
export async function clearMemories(item: OwnedItem, store: MemoryStore = defaultStore()): Promise<{ cleared: string[] }> {
    return { cleared: await store.clearScheduleCoverage(item.userId, item.id) };
}

/** Undo a clear: only rows of this task and owner that were cleared come back. */
export async function restoreMemories(item: OwnedItem, ids: string[], store: MemoryStore = defaultStore()): Promise<{ restored: number }> {
    return { restored: await store.restoreScheduleCoverage(item.userId, item.id, ids) };
}

/** Presentation helpers for memory rows and the type histogram. */

import { translate } from '@/core/i18n';

import { MEMORY_TYPES, memoryTypeLabel, type Memory, type MemoryStats } from './types';

/** A row can carry a shorter restatement; show whichever exists. */
export function memoryLine(memory: Memory): string {
    return memory.summary?.trim() || memory.content;
}

/** The sheet's type label: the server id with its first letter raised. */
export function capitalise(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * One memory's type, singular ("Instruction"): the chat's own keys carry the
 * same seven words, so the badge of a row is translated wherever the web's is.
 */
export function memoryTypeSingular(type: string): string {
    switch (type) {
        case 'instruction':
            return translate('chat.memory.type_instruction', 'Instruction');
        case 'person':
            return translate('chat.memory.type_person', 'Person');
        case 'project':
            return translate('chat.memory.type_project', 'Project');
        case 'preference':
            return translate('chat.memory.type_preference', 'Preference');
        case 'workflow':
            return translate('chat.memory.type_workflow', 'Workflow');
        case 'fact':
            return translate('chat.memory.type_fact', 'Fact');
        case 'context':
            return translate('chat.memory.type_context', 'Context');
        default:
            return capitalise(type);
    }
}

/** Enough of the sentence to recognise it, without a wall of text in a sheet. */
export function truncate(text: string, max = 160): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Pair the stats histogram's parallel arrays back into counts per type. */
export function countsByType(stats: MemoryStats | null | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    if (!stats) return out;
    stats.typeDistribution.labels.forEach((label, i) => {
        const count = stats.typeDistribution.data[i];
        if (typeof count === 'number') out[label] = count;
    });
    return out;
}

export interface TypeChip {
    id: string;
    label: string;
    count: number;
}

/**
 * The filter chips: the seven known types that have rows, then any type this
 * build does not know — the import extractor and the automation bookkeeping both
 * write ids outside the seven, and those rows still need a way to be found
 * and deleted.
 */
export function typeChips(stats: MemoryStats | null | undefined): TypeChip[] {
    const counts = countsByType(stats);
    const chip = (id: string): TypeChip => ({ id, label: memoryTypeLabel(id), count: counts[id] ?? 0 });
    const known = MEMORY_TYPES.filter((id) => (counts[id] ?? 0) > 0).map(chip);
    const extra = Object.keys(counts)
        .filter((id) => !MEMORY_TYPES.includes(id))
        .map(chip);
    return [...known, ...extra];
}

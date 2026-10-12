/**
 * The memory vocabulary: types, origins, the Memory shape the API returns, and
 * one place to turn an id into a label.
 *
 * Mirrors `MEMORY_TYPES` in `server/routes/memory.js`, which is the source of
 * truth. `schedule_coverage` is deliberately absent: it is internal
 * bookkeeping and never reaches a user-facing list.
 */
import {
    Bookmark, User, Folder, Settings as SettingsIcon, Workflow, FileText, Building2,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { TranslateFn } from '../../../hooks/useTranslation';

export const MEMORY_TYPE_IDS = [
    'instruction',
    'person',
    'project',
    'preference',
    'workflow',
    'fact',
    'context',
] as const;

export type MemoryType = (typeof MEMORY_TYPE_IDS)[number];
export type MemoryOrigin = 'explicit' | 'inferred' | 'imported' | 'tool';
export type MemoryStatus = 'active' | 'pending_review' | 'archived' | 'superseded' | 'expired';
export type MemorySort = 'recent' | 'last_used' | 'importance';
export type MemoryScope = 'personal' | 'agent' | 'project' | 'all';
export type MemoryView = 'active' | 'review' | 'archived';

export interface Memory {
    id: string;
    type: MemoryType;
    content: string;
    summary: string | null;
    importance: number;
    origin: MemoryOrigin;
    sensitivity: 'none' | 'art9';
    status: MemoryStatus;
    agent_id: string | null;
    agent_name: string | null;
    project_id: string | null;
    project_name: string | null;
    source_conversation_id: string | null;
    source_conversation_kind: 'agent' | 'direct' | null;
    created_at: string;
    updated_at: string;
    valid_from: string | null;
    last_used_at: string | null;
    use_count: number;
    created_by_name?: string | null;
}

export interface MemoryStats {
    total: number;
    typeDistribution?: { labels: string[]; data: number[] };
    lastUpdatedAt?: string | null;
    pendingReview?: number;
    byOrigin?: Partial<Record<MemoryOrigin, number>>;
}

export const TYPE_ICONS: Record<MemoryType, ComponentType<{ className?: string }>> = {
    instruction: Bookmark,
    person: User,
    project: Folder,
    preference: SettingsIcon,
    workflow: Workflow,
    fact: FileText,
    context: Building2,
};

const TYPE_FALLBACKS: Record<MemoryType, string> = {
    instruction: 'Instructions',
    person: 'People',
    project: 'Projects',
    preference: 'Preferences',
    workflow: 'Workflows',
    fact: 'Facts',
    context: 'Context',
};

const TYPE_SINGULAR_FALLBACKS: Record<MemoryType, string> = {
    instruction: 'Instruction',
    person: 'Person',
    project: 'Project',
    preference: 'Preference',
    workflow: 'Workflow',
    fact: 'Fact',
    context: 'Context',
};

export const isMemoryType = (id: string): id is MemoryType => (MEMORY_TYPE_IDS as readonly string[]).includes(id);

/** Translated plural label ("Facts"); an unknown type degrades to its raw id. */
export function typeLabel(t: TranslateFn, id: string): string {
    if (!isMemoryType(id)) return id;
    return t(`settings.memory_type_${id}`, TYPE_FALLBACKS[id]);
}

/** Translated singular label ("Fact"), for a badge or a select option. */
export function typeSingularLabel(t: TranslateFn, id: string): string {
    if (!isMemoryType(id)) return id;
    return t(`knowledge.memory_type_one_${id}`, TYPE_SINGULAR_FALLBACKS[id]);
}

/** Types a person may add by hand: a project holds project-relevant ones, personal memory never holds 'project'. */
export function addableTypes(inProject: boolean): MemoryType[] {
    return inProject
        ? ['instruction', 'project', 'fact', 'context']
        : ['instruction', 'person', 'preference', 'workflow', 'fact', 'context'];
}

/** Where the "Open source chat" link goes, or null when the memory has no usable source. */
export function sourceChatHref(m: Pick<Memory, 'source_conversation_id' | 'source_conversation_kind' | 'agent_id'>): string | null {
    const id = m.source_conversation_id;
    if (!id) return null;
    if (m.source_conversation_kind === 'direct') return `/app/d/${encodeURIComponent(id)}`;
    if (m.source_conversation_kind === 'agent' && m.agent_id) {
        return `/app/a/${encodeURIComponent(m.agent_id)}/${encodeURIComponent(id)}`;
    }
    return null;
}

export function originLabel(t: TranslateFn, origin: MemoryOrigin): string {
    switch (origin) {
        case 'explicit': return t('knowledge.memory_origin_explicit', 'You added');
        case 'inferred': return t('knowledge.memory_origin_inferred', 'Learned in chat');
        case 'imported': return t('knowledge.memory_origin_imported', 'Imported');
        case 'tool': return t('knowledge.memory_origin_tool', 'Saved by assistant');
        default: return origin;
    }
}

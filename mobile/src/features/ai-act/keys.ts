/**
 * React Query keys for the AI Act declaration. Under ['compliance', 'ai-act'],
 * so a Compliance Center write (which invalidates ['compliance']) refreshes them.
 */

import type { AiActKind } from './api';

export const aiActKeys = {
    all: ['compliance', 'ai-act'] as const,
    list: ['compliance', 'ai-act', 'list'] as const,
    one: (kind: AiActKind, id: string) => ['compliance', 'ai-act', kind, id] as const,
};

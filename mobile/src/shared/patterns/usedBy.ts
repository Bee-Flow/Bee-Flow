/**
 * The words and the link of one "Used by" row — the web's UsedByTab
 * (agent-hub shared/UsedByTab.jsx) minus the table.
 *
 * Pure, so the two screens that list usage (a skill, a knowledge base) and
 * their tests read one answer: what the row is called, what it does with the
 * thing, and where tapping it goes. A row the server marked `foreign` (someone
 * else's agent) is named but never opened: the caller could not read it.
 */

import type { DeleteGuardRow } from '@/core/api/deleteGuard';
import type { TranslateFn } from '@/core/i18n';
import { kindLabel } from '@/shared/ui';

/** Where each kind opens on the phone. A kind without a screen here is not a link. */
const ROUTE_BY_KIND: Readonly<Record<string, string>> = {
    agent: '/agents/',
    automation: '/automations/',
    kb: '/knowledge/',
    skill: '/skills/',
    notebook: '/notebooks/',
    webpage: '/webpages/',
    project: '/projects/',
};

export function usageHref(row: Pick<DeleteGuardRow, 'kind' | 'id' | 'foreign'>): string | null {
    if (row.foreign || !row.id || !row.kind) return null;
    const base = ROUTE_BY_KIND[row.kind];
    return base ? `${base}${encodeURIComponent(row.id)}` : null;
}

function roleWord(t: TranslateFn, role: string | undefined): string | null {
    switch (role) {
        case 'read': return t('usage.role_read', 'reads');
        case 'write': return t('usage.role_write', 'writes');
        case 'readwrite': return t('usage.role_readwrite', 'reads and writes');
        case 'contains': return t('usage.role_contains', 'contains');
        case 'invokes': return t('usage.role_invokes', 'invokes');
        case 'chat': return t('usage.role_chat', 'chat partner');
        case 'ai_step': return t('usage.role_ai_step', 'AI step');
        case 'answer_block': return t('usage.role_answer_block', 'answer block');
        default: return null;
    }
}

export function usageTitle(t: TranslateFn, row: DeleteGuardRow): string {
    const kind = kindLabel(t, row.kind);
    if (row.foreign) return t('usage.someone_elses_kind', 'Someone else’s {kind}', { kind });
    return row.title?.trim() || t('usage.untitled_kind', 'Untitled {kind}', { kind });
}

/** "automation · AI step · step 3" — only the parts the row actually has. */
export function usageSubtitle(t: TranslateFn, row: DeleteGuardRow): string {
    return [kindLabel(t, row.kind), roleWord(t, row.role), row.siteLabel || null].filter(Boolean).join(' · ');
}

import { CHIP, CHIP_ERROR, CHIP_INFO, CHIP_WARNING } from '@/components/mcpLibrary/ui';
import type { TranslateFn } from '@/hooks/useTranslation';

// Mirrors server/auth/permissions.js OrgRoles for display purposes.
export function roleLabel(role: string | null | undefined, t: TranslateFn): string {
    if (!role) return t('support.inbox_role_guest', 'Guest');
    const labels: Record<string, string> = {
        org_admin: t('support.inbox_role_org_admin', 'Org admin'),
        admin: t('support.inbox_role_org_admin', 'Org admin'), // legacy variant — normalised to org_admin server-side
        dpo: t('support.inbox_role_dpo', 'DPO'),
        agent_admin: t('support.inbox_role_agent_admin', 'Agent admin'),
        agent_editor: t('support.inbox_role_agent_editor', 'Agent editor'),
        member: t('support.inbox_role_member', 'Member'),
    };
    return labels[role] || role;
}

/** The statuses of a thread, in the order of the status picker. */
export function statusLabels(t: TranslateFn): Record<string, string> {
    return {
        open: t('support.inbox_status_open', 'Open'),
        ai_responding: t('support.inbox_status_ai_responding', 'AI replying'),
        awaiting_user: t('support.inbox_status_awaiting_user', 'Awaiting user'),
        awaiting_agent: t('support.inbox_status_awaiting_agent', 'Awaiting agent'),
        resolved: t('support.inbox_status_resolved', 'Resolved'),
        closed: t('support.inbox_status_closed', 'Closed'),
    };
}

/** The status dot of a thread row, as a theme-token class. */
export const STATUS_DOT: Record<string, string> = {
    open: 'bg-[var(--info)]',
    ai_responding: 'bg-[var(--info)]',
    awaiting_user: 'bg-[var(--text-tertiary)]',
    awaiting_agent: 'bg-[var(--warning)]',
    resolved: 'bg-[var(--success)]',
    closed: 'bg-[var(--text-tertiary)]',
};

/** Priority names and the chip each one is drawn as (the CHIP recipes of mcpLibrary/ui). */
export function priorityBadges(t: TranslateFn): Record<string, { label: string; cls: string }> {
    return {
        low: { label: t('support.inbox_priority_low', 'Low'), cls: CHIP },
        normal: { label: t('support.inbox_priority_normal', 'Normal'), cls: CHIP_INFO },
        high: { label: t('support.inbox_priority_high', 'High'), cls: CHIP_WARNING },
        urgent: { label: t('support.inbox_priority_urgent', 'Urgent'), cls: CHIP_ERROR },
    };
}

export function formatRelative(iso?: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const m = Math.round(diffMs / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}

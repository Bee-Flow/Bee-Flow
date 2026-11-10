import { CHIP, CHIP_ERROR, CHIP_INFO, CHIP_WARNING } from '@/components/mcpLibrary/ui';

// Mirrors server/auth/permissions.js OrgRoles for display purposes.
const ROLE_LABELS: Record<string, string> = {
    org_admin: 'Org admin',
    admin: 'Org admin',         // legacy variant — normalised to org_admin server-side
    dpo: 'DPO',
    agent_admin: 'Agent admin',
    agent_editor: 'Agent editor',
    member: 'Member',
};
export function roleLabel(role?: string | null): string {
    if (!role) return 'Guest';
    return ROLE_LABELS[role] || role;
}

export const STATUS_LABELS: Record<string, string> = {
    open: 'Open',
    ai_responding: 'AI replying',
    awaiting_user: 'Awaiting user',
    awaiting_agent: 'Awaiting agent',
    resolved: 'Resolved',
    closed: 'Closed',
};

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
export const PRIORITY_BADGES: Record<string, { label: string; cls: string }> = {
    low: { label: 'Low', cls: CHIP },
    normal: { label: 'Normal', cls: CHIP_INFO },
    high: { label: 'High', cls: CHIP_WARNING },
    urgent: { label: 'Urgent', cls: CHIP_ERROR },
};

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

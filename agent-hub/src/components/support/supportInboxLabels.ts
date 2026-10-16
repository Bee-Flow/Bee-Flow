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

export const STATUS_DOT: Record<string, string> = {
    open: '#3b82f6',
    ai_responding: '#0ea5e9',
    awaiting_user: '#94a3b8',
    awaiting_agent: '#f59e0b',
    resolved: '#10b981',
    closed: '#6b7280',
};

export const PRIORITY_BADGES: Record<string, { label: string; bg: string; fg: string }> = {
    low: { label: 'Low', bg: 'rgba(148,163,184,0.15)', fg: '#64748b' },
    normal: { label: 'Normal', bg: 'rgba(59,130,246,0.12)', fg: '#2563eb' },
    high: { label: 'High', bg: 'rgba(245,158,11,0.15)', fg: '#b45309' },
    urgent: { label: 'Urgent', bg: 'rgba(239,68,68,0.15)', fg: '#dc2626' },
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

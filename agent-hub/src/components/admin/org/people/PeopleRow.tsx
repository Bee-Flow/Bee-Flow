import { Check, Clock, Edit2, ServerCog, Shield, Trash2, X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import RoleBadge from '@/components/shared/RoleBadge';
import { mayManageAccount } from '@/utils/adminAccess';
import { PLATFORM_ADMIN_ROLE } from '../userManagement/PlatformAdminField';
import type { AdminUser } from '../userManagement/types';

export type PeopleUser = AdminUser;

export interface PeopleRowProps {
    user: PeopleUser;
    orgChips?: string[];
    onEdit?: (user: PeopleUser) => void;
    onResetMfa?: (user: PeopleUser) => void;
    onDelete?: (user: PeopleUser) => void;
    /** Let a pending account in (it becomes an active member). */
    onApprove?: (user: PeopleUser) => void;
    /** Turn a pending account away (removes it). */
    onReject?: (user: PeopleUser) => void;
    canManage?: boolean;
    /** The viewer is a platform admin: only then may a platform admin's row be edited, reset or deleted (the server refuses anyone else). */
    viewerIsPlatformAdmin?: boolean;
    /**
     * The viewer's home organisation. Anyone but a platform admin manages only
     * accounts whose home organisation this is (the server decides on the
     * target's home organisation); a member through a group alone stays listed, read-only.
     */
    viewerHomeOrgId?: string | null;
}

/** The "Pending" chip of an account waiting to be let in. */
function PendingBadge() {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--warning-ink)]">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {t('admin_org.users_pending', 'Pending')}
        </span>
    );
}

/** Let a pending account in, or turn it away. */
function PendingButtons({ user, onApprove, onReject }: { user: PeopleUser; onApprove?: (user: PeopleUser) => void; onReject?: (user: PeopleUser) => void }) {
    const { t } = useTranslation();
    const name = user.displayName || user.username;
    return (
        <>
            {onApprove && (
                <button
                    onClick={() => onApprove(user)}
                    aria-label={`${t('admin_org.users_approve_title', 'Approve user')}: ${name}`}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--success-ink)] hover:bg-[color-mix(in_srgb,var(--success)_12%,transparent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                >
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('admin.org_approve', 'Approve')}
                </button>
            )}
            {onReject && (
                <button
                    onClick={() => onReject(user)}
                    aria-label={`${t('admin_org.users_reject_title', 'Reject user')}: ${name}`}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('admin.org_reject', 'Reject')}
                </button>
            )}
        </>
    );
}

/**
 * One person in the directory.
 *
 * Two deliberate departures from the table this replaces
 * (UserManagement.jsx:469-523):
 *
 *  1. Actions are ALWAYS rendered. The `xl:opacity-0 xl:group-hover:opacity-100`
 *     reveal used across UserManagement is a tab stop you cannot see — an
 *     accessibility defect, not a style choice. (Its root cause is the inline
 *     `style={{}}` idiom, which cannot express hover/focus variants at all.)
 *  2. No avatar image branch. getAllUsers() deliberately excludes `avatar`
 *     (userStore.js:811-812), so the old emoji/image branches could never fire —
 *     every row already falls through to the initial. Rendering a branch that
 *     cannot execute is worse than not having it; real avatars need
 *     getAllUserAvatars and a second round-trip.
 */
export default function PeopleRow({ user, orgChips = [], onEdit, onResetMfa, onDelete, onApprove, onReject, canManage = false, viewerIsPlatformAdmin = false, viewerHomeOrgId = null }: PeopleRowProps) {
    const { t } = useTranslation();
    const isSystem = user.isSystem || user.id === 'admin';
    const isPlatformAdmin = user.role === PLATFORM_ADMIN_ROLE;
    const showActions = canManage && !isSystem && mayManageAccount(user, viewerIsPlatformAdmin, viewerHomeOrgId);
    const isPending = user.status === 'pending';
    const initial = (user.displayName?.[0] || user.username?.[0] || '?').toUpperCase();

    return (
        <div
            className="px-5 py-2.5 flex items-center gap-3 hover:bg-[var(--bg-card-hover)] transition-colors"
            data-testid="people-row"
        >
            <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium text-white flex-shrink-0 [background:linear-gradient(135deg,var(--accent-primary),var(--accent-secondary))]"
                aria-hidden="true"
            >
                {initial}
            </div>

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {user.displayName || user.username}
                    </span>
                    {/* The organisation role (its organisation is the section
                        header, or a chip in the flat view) and, apart from it,
                        the platform role: two kinds of admin, told apart. */}
                    {(user.orgRole || !isPlatformAdmin) && <RoleBadge role={user.orgRole || user.role} tone="neutral" />}
                    {isPlatformAdmin && (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--accent-primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-primary)]">
                            <ServerCog className="h-3 w-3" aria-hidden="true" />
                            {t('admin_org.platform_admin_badge', 'Platform admin')}
                        </span>
                    )}
                    {isPending && <PendingBadge />}
                    {orgChips.map((chip) => (
                        <span
                            key={chip}
                            className="whitespace-nowrap rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]"
                        >
                            {chip}
                        </span>
                    ))}
                </div>
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span className="truncate">@{user.username || user.id}</span>
                    {user.email && <span className="truncate">· {user.email}</span>}
                </div>
            </div>

            {showActions && (
                <div className="flex items-center gap-1 flex-shrink-0">
                    {isPending && <PendingButtons user={user} onApprove={onApprove} onReject={onReject} />}
                    <button
                        onClick={() => onEdit?.(user)}
                        aria-label={t('admin.sec_people_edit', 'Edit {name}', { name: user.displayName || user.username })}
                        className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    >
                        <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onResetMfa?.(user)}
                        aria-label={t('admin.sec_people_reset_mfa', 'Reset 2FA for {name}', { name: user.displayName || user.username })}
                        className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    >
                        <Shield className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onDelete?.(user)}
                        aria-label={t('admin.sec_people_delete', 'Delete {name}', { name: user.displayName || user.username })}
                        className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] hover:text-[var(--error-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            )}
        </div>
    );
}

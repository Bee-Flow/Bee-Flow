import { X, Mail, Clock } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import RoleBadge from '../../../shared/RoleBadge';
import type { Invitation } from '../useOrgInvitations';

interface PendingInvitationsProps {
    /** Already filtered to the pending ones; the caller renders nothing when empty. */
    pending: Invitation[];
    onRevoke: (invitationId: string) => void;
}

export default function PendingInvitations({ pending, onRevoke }: PendingInvitationsProps) {
    const { t } = useTranslation();
    return (
        <div className="border-t border-[var(--border-subtle)]">
            <div className="px-5 py-3 bg-[var(--bg-secondary)]">
                <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">{t('admin_org.users_pending_invitations', 'Pending Invitations')}</h4>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
                {pending.map(inv => (
                    <div key={inv.id} className="px-5 py-2.5 flex items-center gap-4">
                        <div className="w-9 h-9 rounded-full bg-[var(--accent-primary)]/10 flex items-center justify-center shrink-0">
                            <Mail className="w-4 h-4 text-[var(--accent-primary)]" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-[var(--text-primary)] truncate">{inv.email}</span>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-500 flex items-center gap-1">
                                    <Clock className="w-2.5 h-2.5" />
                                    {t('admin_org.users_invited', 'Invited')}
                                </span>
                                {inv.role && inv.role !== 'user' && <RoleBadge role={inv.role} />}
                            </div>
                            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                                {t('admin_org.users_invited_by', 'Invited by {name} · Expires {date}', { name: inv.inviterName || t('admin_org.users_unknown', 'Unknown'), date: new Date(inv.expires_at as string).toLocaleDateString() })}
                            </div>
                        </div>
                        <button
                            onClick={() => onRevoke(inv.id)}
                            className="text-xs px-2 py-1 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                            title={t('admin_org.users_revoke_invite', 'Revoke invitation')}
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}

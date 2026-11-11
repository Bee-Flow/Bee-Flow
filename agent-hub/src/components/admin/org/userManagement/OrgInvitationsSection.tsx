import { useTranslation } from '@/hooks/useTranslation';
import InviteForm from '../orgUsers/InviteForm';
import PendingInvitations from '../orgUsers/PendingInvitations';
import useOrgInvitations from '../useOrgInvitations';

/** Invite someone who has no account yet, and the invitations still waiting for an answer. */
export default function OrgInvitationsSection() {
    const { t } = useTranslation();
    const invites = useOrgInvitations();
    const pending = invites.invitations.filter(i => i.status === 'pending');
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)]">
            <div className="px-5 py-4 border-b border-[var(--border-default)]">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin.org_invite_user', 'Invite User')}</h3>
            </div>
            <InviteForm {...invites} />
            {pending.length > 0 && <PendingInvitations pending={pending} onRevoke={invites.handleRevokeInvite} />}
        </div>
    );
}

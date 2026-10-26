import { Check, Send, Link2, AlertCircle } from 'lucide-react';
import { ORG_ROLES } from '@/config/orgRoles';
import { useTranslation } from '@/hooks/useTranslation';
import type { OrgInvitations } from '../useOrgInvitations';

type InviteFormProps = Pick<OrgInvitations,
    'inviteEmail' | 'setInviteEmail' | 'inviteRole' | 'setInviteRole'
    | 'sendingInvite' | 'inviteResult' | 'handleSendInvite'>;

/** E-mail + role, and the outcome of the last invite (with its fallbacks). */
export default function InviteForm({
    inviteEmail, setInviteEmail, inviteRole, setInviteRole,
    sendingInvite, inviteResult, handleSendInvite,
}: InviteFormProps) {
    const { t } = useTranslation();
    return (
        <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--accent-primary)]/5">
            <div className="flex items-end gap-3">
                <div className="flex-1">
                    <label className="block text-[10px] font-medium text-[var(--text-muted)] mb-1 uppercase tracking-wider">{t('admin_org.users_email_address', 'Email Address')}</label>
                    <input
                        type="email"
                        value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSendInvite()}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-primary)] transition-colors"
                        placeholder="colleague@example.com"
                        autoFocus
                    />
                </div>
                <div className="w-40">
                    <label className="block text-[10px] font-medium text-[var(--text-muted)] mb-1 uppercase tracking-wider">{t('admin_org.users_role', 'Role')}</label>
                    <select
                        value={inviteRole}
                        onChange={e => setInviteRole(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none"
                    >
                        <option value="user">{t('admin_org.users_user', 'User')}</option>
                        {ORG_ROLES.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                    </select>
                </div>
                <button
                    onClick={handleSendInvite}
                    disabled={sendingInvite || !inviteEmail.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                    {sendingInvite ? (
                        <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        <Send className="w-3.5 h-3.5" />
                    )}
                    {t('admin_org.users_send', 'Send')}
                </button>
            </div>
            {inviteResult && (
                <div className={`mt-3 flex items-start gap-2 text-xs px-3 py-2 rounded-lg ${inviteResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                    {inviteResult.success ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                    <div>
                        <span>{inviteResult.message}</span>
                        {inviteResult.inviteUrl && (
                            <button
                                onClick={() => { navigator.clipboard.writeText(inviteResult.inviteUrl as string); }}
                                className="flex items-center gap-1 mt-1 text-[var(--accent-primary)] hover:underline"
                            >
                                <Link2 className="w-3 h-3" />
                                {t('admin_org.users_copy_invite', 'Copy invite link')}
                            </button>
                        )}
                        {/* BFSF-251: seat cap → direct upgrade path, no dead end */}
                        {inviteResult.upgradeLink && (
                            <a
                                href="/app/settings/organisation/license"
                                className="flex items-center gap-1 mt-1 font-semibold text-[var(--accent-primary)] hover:underline"
                            >
                                {t('agent_wizard.view_plans', 'View plans & upgrade')}
                            </a>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

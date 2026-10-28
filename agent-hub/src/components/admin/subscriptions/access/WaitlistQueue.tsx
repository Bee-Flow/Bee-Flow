import { CheckCircle, Clock, Trash2 } from 'lucide-react';
import type { WaitlistUser } from './useSignupSettings';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import EmptyState from '@/components/shared/EmptyState';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

interface WaitlistQueueProps {
    users: WaitlistUser[];
    onApprove: (u: WaitlistUser) => void;
    onReject: (u: WaitlistUser) => void;
}

/** Users waiting for account approval. */
export default function WaitlistQueue({ users, onApprove, onReject }: WaitlistQueueProps) {
    const { t } = useTranslation();
    return (
        <div>
            <div className="flex items-end justify-between gap-4 mb-3">
                <div>
                    <h3 className="flex items-center gap-2 text-[16px] font-bold text-[var(--text-primary)]">
                        <Clock className="w-4 h-4 text-amber-400" />
                        {t('admin_subscriptions.access_waitlist_queue', 'Waitlist queue')}
                        {users.length > 0 && <Badge tone="warning" size="sm">{users.length}</Badge>}
                    </h3>
                    <p className="text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.access_waitlist_queue_desc', 'Users waiting for account approval.')}</p>
                </div>
            </div>

            {users.length === 0 ? (
                <EmptyState
                    icon={<CheckCircle className="w-6 h-6" />}
                    title={t('admin_subscriptions.access_waitlist_empty', 'No users in the waitlist')}
                    description={t('admin_subscriptions.access_waitlist_empty_desc', 'When waitlist mode is on, new signups appear here for approval.')}
                />
            ) : (
                <Card padded={false}>
                    {users.map((u, idx) => (
                        <div
                            key={u.id}
                            className={`flex items-center justify-between gap-3 px-4 py-3 ${idx < users.length - 1 ? 'border-b border-[var(--border-default)]' : ''}`}
                        >
                            <div className="min-w-0">
                                <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{u.displayName || u.username}</div>
                                <div className="flex flex-wrap gap-x-3 mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                                    {u.email && <span>{u.email}</span>}
                                    {u.createdAt && <span>{t('admin_subscriptions.access_signed_up', 'Signed up {date}', { date: new Date(u.createdAt).toLocaleDateString() })}</span>}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="success" icon={CheckCircle} onClick={() => onApprove(u)}>{t('admin_subscriptions.access_approve', 'Approve')}</Button>
                                <Button size="sm" variant="danger" icon={Trash2} onClick={() => onReject(u)}>{t('admin_subscriptions.access_reject', 'Reject')}</Button>
                            </div>
                        </div>
                    ))}
                </Card>
            )}
        </div>
    );
}

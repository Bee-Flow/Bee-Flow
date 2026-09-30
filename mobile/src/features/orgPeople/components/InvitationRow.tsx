/** One invitation: who, with which role, who sent it, and — while open — Revoke. */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { timeAgo, useTranslation } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';
import { useConfirm } from '@/shared/patterns';
import { Badge, Button, ListRow, useToast } from '@/shared/ui';

import { useRevokeInvitation } from '../hooks/memberMutations';
import { roleCopy } from '../model/roles';
import type { Invitation } from '../model/types';

export function InvitationRow({ invitation }: { invitation: Invitation }) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const revoke = useRevokeInvitation();
    const open = (invitation.status ?? 'pending') === 'pending';
    const role = roleCopy(invitation.role || 'user', t).name;
    const by = invitation.inviterName
        ? t('mobile.orgPeople.invited_by', 'Invited by {name}', { name: invitation.inviterName })
        : '';

    const onRevoke = async () => {
        const ok = await confirm({
            title: t('mobile.orgPeople.revoke_title', 'Revoke this invitation?'),
            message: t('mobile.orgPeople.revoke_message', 'The link in the e-mail stops working.'),
            confirmLabel: t('mobile.orgPeople.revoke', 'Revoke'),
        });
        if (ok) revoke.mutate(invitation.id, { onError: (e) => toast(describeError(e).message, 'error') });
    };

    return (
        <ListRow
            testID={`invitation-${invitation.id}`}
            title={invitation.email}
            subtitle={[role, by].filter(Boolean).join(' · ')}
            meta={timeAgo(invitation.created_at, { suffix: true }) || undefined}
            chevron={false}
            trailing={
                open ? (
                    <Button
                        testID={`revoke-${invitation.id}`}
                        size="sm"
                        variant="ghost"
                        label={t('mobile.orgPeople.revoke', 'Revoke')}
                        loading={revoke.isPending}
                        onPress={() => void onRevoke()}
                    />
                ) : (
                    <Badge label={humanise(invitation.status)} />
                )
            }
        />
    );
}

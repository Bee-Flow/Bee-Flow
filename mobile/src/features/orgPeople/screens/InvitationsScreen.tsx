/**
 * Invitations — the web's invite form and its "Pending Invitations" list
 * (useOrgInvitations): invite by e-mail with a role, see who was invited and
 * by whom, revoke an open one. Org administrators only: every one of these
 * routes checks isOrgAdminForOrg, which `manage_users` alone does not pass.
 * `startInviting` (the route's `?new=1`) opens the invite sheet straight away.
 */

import React from 'react';
import type { ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { InvitationRow } from '../components/InvitationRow';
import { InviteLinkBanner } from '../components/InviteLinkBanner';
import { InviteSheet } from '../components/InviteSheet';
import { LockedScreen } from '../components/LockedScreen';
import { useInvitations } from '../hooks/queries';
import { useInviteFlow } from '../hooks/useInviteFlow';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import type { Invitation } from '../model/types';

const renderItem: ListRenderItem<Invitation> = ({ item }) => <InvitationRow invitation={item} />;
const keyOf = (item: Invitation) => item.id;

export function InvitationsScreen({ startInviting = false }: { startInviting?: boolean }) {
    const t = useTranslation();
    const { isOrgAdmin } = usePeopleAccess();
    const invitations = useInvitations(isOrgAdmin);
    const invite = useInviteFlow(isOrgAdmin, startInviting);

    const title = t('mobile.orgPeople.invitations', 'Invitations');
    if (!isOrgAdmin) return <LockedScreen title={title} />;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title={title}
                actions={
                    <Button
                        testID="open-invite"
                        size="sm"
                        iconName="Send"
                        label={t('mobile.orgPeople.invite', 'Invite')}
                        onPress={invite.open}
                    />
                }
            />
            {invite.manualLink ? <InviteLinkBanner url={invite.manualLink} onDismiss={invite.dismissLink} /> : null}
            <QueryList
                query={invitations}
                renderItem={renderItem}
                keyExtractor={keyOf}
                empty={{
                    icon: 'Mail',
                    title: t('mobile.orgPeople.no_invitations', 'No invitations'),
                    message: t(
                        'mobile.orgPeople.no_invitations_message',
                        'Invite a colleague by e-mail. They join your organisation when they accept.',
                    ),
                    actionLabel: t('admin.org_invite_user', 'Invite User'),
                    onAction: invite.open,
                }}
            />
            <InviteSheet {...invite.sheet} />
        </Screen>
    );
}

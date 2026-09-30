/**
 * One person on the roster: name, e-mail, their role (or "Pending"), and for a
 * pending sign-up the web's Approve / Reject pair. Marked when it is you.
 * Opens the member's own screen, so every row keeps its chevron.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Avatar, Badge, Icon, IconButton, ListRow, useToast } from '@/shared/ui';

import { useApproveMember, useDeleteMember } from '../hooks/memberMutations';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { displayName, isPending, memberRole } from '../model/members';
import { roleCopy } from '../model/roles';
import type { Member } from '../model/types';

function PendingActions({ member }: { member: Member }) {
    const t = useTranslation();
    const theme = useTheme();
    const confirm = useConfirm();
    const { toast } = useToast();
    const approve = useApproveMember();
    const reject = useDeleteMember();
    const onError = (error: unknown) => toast(describeError(error).message, 'error');
    const busy = approve.isPending || reject.isPending;

    const onReject = async () => {
        const ok = await confirm({
            title: t('mobile.orgPeople.reject_named_title', 'Reject {name}?', { name: displayName(member) }),
            message: t('mobile.orgPeople.reject_message', 'They can sign up again later.'),
            confirmLabel: t('admin.org_reject', 'Reject'),
        });
        if (ok) reject.mutate(member.id, { onError });
    };

    return (
        <View style={styles.actions}>
            <IconButton
                testID={`approve-${member.id}`}
                accessibilityLabel={t('admin.org_approve', 'Approve')}
                icon={<Icon name="Check" size={18} color={theme.colors.successInk} />}
                disabled={busy}
                onPress={() => approve.mutate(member.id, { onError })}
            />
            <IconButton
                testID={`reject-${member.id}`}
                tone="danger"
                accessibilityLabel={t('admin.org_reject', 'Reject')}
                icon={<Icon name="X" size={18} color={theme.colors.errorInk} />}
                disabled={busy}
                onPress={() => void onReject()}
            />
        </View>
    );
}

export function MemberRow({ member }: { member: Member }) {
    const { user } = useAuth();
    const t = useTranslation();
    const router = useRouter();
    const { isOrgAdmin } = usePeopleAccess();
    const name = displayName(member);
    const pending = isPending(member);

    let trailing: React.ReactNode;
    if (pending && isOrgAdmin) trailing = <PendingActions member={member} />;
    else if (pending) trailing = <Badge label={t('admin.org_status_pending', 'Pending')} tone="warning" icon="Clock" />;
    else if (member.id === user?.id) trailing = <Badge label={t('mobile.orgPeople.you', 'You')} tone="accent" />;
    else trailing = <Badge label={roleCopy(memberRole(member), t).name} />;

    return (
        <ListRow
            testID={`member-${member.id}`}
            title={name}
            subtitle={pending ? t('admin.org_status_pending', 'Pending') : member.email || member.username || member.id}
            leading={<Avatar name={name} uri={member.avatar?.startsWith('http') ? member.avatar : null} size={38} />}
            trailing={trailing}
            chevron
            onPress={() => router.push(`/org/members/${encodeURIComponent(member.id)}`)}
        />
    );
}

const styles = StyleSheet.create({
    actions: { flexDirection: 'row', gap: 4 },
});

/**
 * A pending sign-up's two answers, at the top of their page because they are
 * the reason an administrator opened it: Approve, or Reject (which deletes
 * the sign-up; they can sign up again).
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Button, useToast } from '@/shared/ui';

import { useApproveMember, useDeleteMember } from '../hooks/memberMutations';
import { displayName } from '../model/members';
import type { Member } from '../model/types';

export function PendingMemberActions({ member }: { member: Member }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
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
        if (ok) reject.mutate(member.id, { onError, onSuccess: () => router.back() });
    };

    return (
        <View style={styles.row}>
            <View style={styles.cell}>
                <Button
                    testID="member-approve"
                    variant="success"
                    iconName="Check"
                    label={t('admin.org_approve', 'Approve')}
                    loading={approve.isPending}
                    disabled={busy}
                    onPress={() => approve.mutate(member.id, { onError })}
                    fullWidth
                />
            </View>
            <View style={styles.cell}>
                <Button
                    testID="member-reject"
                    variant="danger"
                    iconName="X"
                    label={t('admin.org_reject', 'Reject')}
                    loading={reject.isPending}
                    disabled={busy}
                    onPress={() => void onReject()}
                    fullWidth
                />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing.sm },
        cell: { flex: 1 },
    });

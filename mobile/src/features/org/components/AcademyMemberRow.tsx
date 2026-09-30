/**
 * One member of the Academy overview (OrgAcademyPanel.jsx's table row, as a
 * phone row): who, their courses done out of all, badges, certificates by
 * level (never serials — the server does not send them) and last activity.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { apiUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Avatar, Text } from '@/shared/ui';

import { relativeActivity } from '../model/format';
import { serverImageUri } from '../model/profile';
import type { AcademyMember } from '../model/sectionTypes';

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
    } satisfies ViewStyle,
    body: { flex: 1, gap: 2 } satisfies ViewStyle,
});

/** An uploaded or linked avatar; an emoji avatar falls back to initials. */
function avatarUri(member: AcademyMember): string | null {
    if (member.avatarType === 'emoji') return null;
    return serverImageUri(member.avatar, apiUrl);
}

export function AcademyMemberRow({ member, courseCount }: { member: AcademyMember; courseCount: number }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const levels = member.certificates.map((c) => c.level || c.certificateId).join(', ');
    const facts = [
        `${t('org.academy.col_courses', 'Courses')} ${member.coursesDone.length}/${courseCount}`,
        `${t('org.academy.col_badges', 'Badges')} ${member.badges.length || '—'}`,
        `${t('org.academy.col_certs', 'Certificates')} ${levels || '—'}`,
    ].join(' · ');
    return (
        <View style={styles.row} testID={`academy-member-${member.userId}`}>
            <Avatar name={member.displayName || '?'} uri={avatarUri(member)} size={36} />
            <View style={styles.body}>
                <Text variant="body" numberOfLines={1}>
                    {member.displayName}
                </Text>
                {member.email ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {member.email}
                    </Text>
                ) : null}
                <Text variant="caption" tone="secondary" numberOfLines={2}>
                    {facts}
                </Text>
            </View>
            <Text variant="caption" tone="tertiary">
                {relativeActivity(member.lastActivity, t)}
            </Text>
        </View>
    );
}

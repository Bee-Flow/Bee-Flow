/**
 * The people on a project: its owner first, then each person or group it is
 * shared with. Names appear only when the directory would give them; else the
 * row says what kind of member it is. A row the caller may act on (the owner
 * on anyone, anyone on their own share) opens its actions.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Avatar, Badge, Icon, ListRow } from '@/shared/ui';

import { memberTitle, roleLabel, type NameFor } from '../model/people';
import type { ProjectShare } from '../model/types';

export function OwnerRow({ ownerId, meId, nameFor }: { ownerId: string; meId: string | undefined; nameFor: NameFor }) {
    const t = useTranslation();
    const name = nameFor({ sharedWithId: ownerId, sharedWithType: 'user' });
    return (
        <ListRow
            title={ownerId === meId ? t('mobile.projects.you', 'You') : (name ?? t('mobile.projects.the_owner', 'The owner'))}
            leading={<Avatar name={name ?? '?'} size={32} />}
            trailing={<Badge label={roleLabel('owner', t)} tone="accent" />}
            chevron={false}
        />
    );
}

export function MemberRow({
    share,
    meId,
    nameFor,
    onPress,
}: {
    share: ProjectShare;
    meId: string | undefined;
    nameFor: NameFor;
    /** Present when the caller may change or remove this member. */
    onPress?: (share: ProjectShare) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const group = share.sharedWithType === 'group';
    return (
        <ListRow
            title={memberTitle(share, meId, nameFor, t)}
            subtitle={group ? t('solutions.install_access_group', 'Group') : undefined}
            leading={group ? <Icon name="Users" size={18} color={theme.colors.textMuted} /> : <Avatar name={nameFor(share) ?? '?'} size={32} />}
            trailing={<Badge label={roleLabel(share.permission, t)} />}
            chevron={Boolean(onPress)}
            onPress={onPress ? () => onPress(share) : undefined}
            testID={`member-${share.id}`}
        />
    );
}

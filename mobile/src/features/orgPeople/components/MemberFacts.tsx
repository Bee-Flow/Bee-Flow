/**
 * What the roster knows about one member, read-only. Role, status and groups
 * are listed only in the read-only view (`withAssignments`): an administrator
 * sees and changes them in their own rows below, so they are not said twice.
 */

import React, { type ReactElement } from 'react';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { absoluteDate, humanise } from '@/shared/lib/display';
import { Group, InfoRow } from '@/shared/ui';

import { isPending, memberRole } from '../model/members';
import { roleCopy } from '../model/roles';
import type { Member, OrgGroup } from '../model/types';

/** Role, status and groups — an array, so the Group draws a divider between each. */
function assignmentRows(member: Member, groups: readonly OrgGroup[], t: TranslateFn): ReactElement[] {
    const groupNames = groups.filter((g) => member.groups.includes(g.id)).map((g) => g.name);
    const status = isPending(member)
        ? t('admin.org_status_pending', 'Pending')
        : t('admin.org_status_active', 'Active');
    return [
        <InfoRow key="role" label={t('mobile.orgPeople.role', 'Role')} value={roleCopy(memberRole(member), t).name} />,
        <InfoRow key="status" label={t('mobile.orgPeople.status', 'Status')} value={status} />,
        <InfoRow
            key="groups"
            label={t('admin.org_assign_groups_title', 'Groups')}
            value={groupNames.length > 0 ? groupNames.join(', ') : '—'}
        />,
    ];
}

export function MemberFacts({
    member,
    groups,
    withAssignments,
}: {
    member: Member;
    groups: readonly OrgGroup[];
    withAssignments: boolean;
}) {
    const t = useTranslation();
    const twoFactor = member.mfaEnabled
        ? t('mobile.orgPeople.mfa_on', 'On')
        : t('mobile.orgPeople.mfa_off', 'Off');
    return (
        <Group title={t('mobile.orgPeople.profile', 'Profile')}>
            {member.email ? <InfoRow label={t('mobile.orgPeople.email', 'Email')} value={member.email} selectable /> : null}
            {member.username ? (
                <InfoRow label={t('mobile.orgPeople.username', 'Username')} value={member.username} selectable />
            ) : null}
            {withAssignments ? assignmentRows(member, groups, t) : null}
            <InfoRow label={t('mobile.orgPeople.two_factor', 'Two-factor authentication')} value={twoFactor} />
            {member.provider ? (
                <InfoRow label={t('mobile.orgPeople.sign_in', 'Signs in with')} value={humanise(member.provider)} />
            ) : null}
            <InfoRow
                label={t('mobile.orgPeople.last_seen', 'Last seen')}
                value={timeAgo(member.lastSeenAt, { suffix: true }) || '—'}
            />
            <InfoRow label={t('mobile.orgPeople.joined', 'Joined')} value={absoluteDate(member.createdAt)} />
        </Group>
    );
}

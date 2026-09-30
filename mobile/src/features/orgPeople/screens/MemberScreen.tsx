/**
 * One member: what the roster knows about them, and — for an organisation
 * administrator — their role, groups, two-factor reset and deletion. A
 * pending sign-up opens on its Approve / Reject. The member is read out of the
 * roster (there is no per-user GET an org admin may call), so a pull refreshes
 * the whole list the Members screen shows too.
 *
 * The role row shows on your own page too: stepping down is allowed, but only
 * deliberately (see useChangeMemberRole). The system account is not editable.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryScreen } from '@/shared/patterns';
import { NoteRow, Group, ScreenHeader } from '@/shared/ui';

import { LockedScreen } from '../components/LockedScreen';
import { MemberActions } from '../components/MemberActions';
import { MemberFacts } from '../components/MemberFacts';
import { PendingMemberActions } from '../components/PendingMemberActions';
import { useGroups, useMembers, useOrgRoles } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { displayName, isPending } from '../model/members';
import { roleOptions } from '../model/roles';

export function MemberScreen({ id }: { id: string }) {
    const t = useTranslation();
    const { isOrgAdmin, canSeePeople } = usePeopleAccess();
    const members = useMembers(canSeePeople);
    const groups = useGroups(canSeePeople);
    const roles = useOrgRoles(isOrgAdmin);

    if (!canSeePeople) return <LockedScreen title={t('mobile.orgPeople.member', 'Member')} manageUsers />;

    const member = members.data?.find((m) => m.id === id);
    const query = { ...members, data: members.data ? member : undefined };
    const refresh = () => Promise.all([members.refetch(), groups.refetch()]);

    return (
        <QueryScreen
            query={query}
            refresh={refresh}
            header={(m) => (
                <ScreenHeader title={m ? displayName(m) : t('mobile.orgPeople.member', 'Member')} subtitle={m?.email} />
            )}
        >
            {(m) =>
                isOrgAdmin && !m.isSystem ? (
                    <>
                        {isPending(m) ? <PendingMemberActions member={m} /> : null}
                        <MemberFacts member={m} groups={groups.data ?? []} withAssignments={false} />
                        <MemberActions
                            member={m}
                            groups={groups.data ?? []}
                            roleIds={roleOptions(roles.data?.roles ?? [])}
                        />
                    </>
                ) : (
                    <>
                        <MemberFacts member={m} groups={groups.data ?? []} withAssignments />
                        <Group>
                            <NoteRow>
                                {t(
                                    'mobile.orgPeople.member_read_only',
                                    'Only an organisation administrator can change a member’s role, groups or access.',
                                )}
                            </NoteRow>
                        </Group>
                    </>
                )
            }
        </QueryScreen>
    );
}

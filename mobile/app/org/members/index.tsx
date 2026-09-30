/**
 * Members. `?status=pending` opens on the sign-ups waiting for approval,
 * `?role=<id>` on the holders of one role. See features/orgPeople.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { OrgMembersScreen } from '@/features/orgPeople';

export default function OrgMembersRoute() {
    const { status, role } = useLocalSearchParams<{ status?: string; role?: string }>();
    return <OrgMembersScreen initialStatus={status} initialRole={role} />;
}

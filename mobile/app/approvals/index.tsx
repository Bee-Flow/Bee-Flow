/**
 * What is waiting on your decision; `?scope=org` opens on the organisation's
 * record (the drawer's row, for an admin with an empty inbox). The screen
 * lives in features/approvals.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ApprovalsScreen } from '@/features/approvals';

export default function ApprovalsRoute() {
    const { scope } = useLocalSearchParams<{ scope?: string }>();
    return <ApprovalsScreen initialScope={scope === 'org' ? 'org' : 'pending'} />;
}

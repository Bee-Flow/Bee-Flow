/** A pointer to the approvals inbox — the count, not a second copy of the list. */

import { useRouter } from 'expo-router';
import React from 'react';

import { Banner, Button } from '@/shared/ui';

export function ApprovalsWaitingBanner({ count }: { count: number }) {
    const router = useRouter();
    return (
        <Banner
            tone="warning"
            icon="Clock"
            action={<Button label="Open" variant="ghost" onPress={() => router.push('/approvals')} />}
        >
            {count === 1 ? '1 decision is waiting on you.' : `${count} decisions are waiting on you.`}
        </Banner>
    );
}

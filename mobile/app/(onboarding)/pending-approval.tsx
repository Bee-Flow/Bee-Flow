/**
 * "Your account is waiting to be let in."
 *
 * The credentials were right and a session exists — server/auth/login/
 * finalizeLogin.js establishes one with `pendingApproval: true` — but the
 * account's status is `waitlist` or `pending`, and nothing in the product is
 * reachable until someone with the authority to approve it does so.
 *
 * There is no endpoint the user can call to hurry this along, and inventing a
 * "request approval" button that posts nowhere would be worse than saying so.
 * What this screen can do is name who has the power (an administrator of their
 * organisation, or the operator of the instance), let them check whether it has
 * happened, and let them leave.
 */

import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';

import { useAuth } from '../../src/auth/AuthProvider';
import { fetchSetupStatus, onboardingKeys } from '../../src/features/onboarding/api';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { Button } from '../../src/ui/Button';
import { Banner } from '../../src/ui/Feedback';
import { Text } from '../../src/ui/Text';

export default function PendingApprovalScreen() {
    const { stage, refresh, signOut } = useAuth();
    // Same reason as verify-email: `busy` is the sign-in flag, not this.
    const [checking, setChecking] = useState(false);
    const user = stage.kind === 'pending-approval' ? stage.user : null;

    // Only used to choose between two sentences, so a failure here is silent:
    // the generic wording below is true either way.
    const status = useQuery({
        queryKey: onboardingKeys.setupStatus,
        queryFn: ({ signal }) => fetchSetupStatus(signal),
        staleTime: 5 * 60_000,
    });

    const waitlist = status.data?.waitlistEnabled === true;
    const hasOrg = Boolean(user?.organizationId);

    return (
        <AuthShell
            icon="clock"
            tone="warning"
            title={waitlist ? 'You are on the waiting list' : 'Waiting for approval'}
            subtitle={
                waitlist
                    ? 'This server admits new accounts in batches. Yours is queued, and you will get an email when it is let in.'
                    : hasOrg
                      ? 'Your account exists, but an administrator of your organisation has to approve it before you can sign in.'
                      : 'Your account exists, but whoever runs this server has to approve it before you can sign in.'
            }
            footer={<TextLink label="Sign out" tone="tertiary" onPress={() => void signOut()} />}
        >
            {user ? (
                <Banner tone="info" icon="user">
                    {user.email
                        ? `Signed in as ${user.displayName} (${user.email})`
                        : `Signed in as ${user.displayName}`}
                </Banner>
            ) : null}

            <Button
                label="Check again"
                onPress={() => {
                    setChecking(true);
                    void refresh().finally(() => setChecking(false));
                }}
                size="lg"
                fullWidth
                loading={checking}
                accessibilityHint="Asks the server whether your account has been approved"
            />

            <Text variant="caption" tone="tertiary" center>
                {hasOrg
                    ? 'If this has been a while, the fastest route is to ask a colleague who administers Bee Flow.'
                    : 'Nothing further is needed from you. Approvals are done by hand, so this can take a day.'}
            </Text>
        </AuthShell>
    );
}

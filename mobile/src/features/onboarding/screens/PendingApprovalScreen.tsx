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

import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, Button, Text } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { TextLink } from '../components/TextLink';
import { useSetupStatus } from '../hooks/queries';

/** Who has to let this account in, in one sentence. */
function whoApproves(t: TranslateFn, waitlist: boolean, hasOrg: boolean): string {
    if (waitlist) {
        return t(
            'mobile.onboarding.pending_waitlist_intro',
            'This server admits new accounts in batches. Yours is queued, and you will get an email when it is let in.',
        );
    }
    return hasOrg
        ? t(
              'mobile.onboarding.pending_org_intro',
              'Your account exists, but an administrator of your organisation has to approve it before you can sign in.',
          )
        : t(
              'mobile.onboarding.pending_server_intro',
              'Your account exists, but whoever runs this server has to approve it before you can sign in.',
          );
}

export function PendingApprovalScreen() {
    const { stage, refresh, signOut } = useAuth();
    const t = useTranslation();
    // Same reason as verify-email: `busy` is the sign-in flag, not this.
    const [checking, setChecking] = useState(false);
    const user = stage.kind === 'pending-approval' ? stage.user : null;

    // Only used to choose between two sentences, so a failure here is silent:
    // the generic wording below is true either way.
    const status = useSetupStatus();
    const waitlist = status.data?.waitlistEnabled === true;
    const hasOrg = Boolean(user?.organizationId);

    return (
        <AuthShell
            icon="Clock"
            tone="warning"
            title={
                waitlist
                    ? t('mobile.onboarding.pending_waitlist_title', 'You are on the waiting list')
                    : t('mobile.onboarding.pending_title', 'Waiting for approval')
            }
            subtitle={whoApproves(t, waitlist, hasOrg)}
            footer={<TextLink label={t('login.sign_out', 'Sign out')} tone="tertiary" onPress={() => void signOut()} />}
        >
            {user ? (
                <Banner tone="info" icon="User">
                    {user.email
                        ? t('mobile.onboarding.signed_in_as_email', 'Signed in as {name} ({email})', {
                              name: user.displayName,
                              email: user.email,
                          })
                        : t('mobile.onboarding.signed_in_as', 'Signed in as {name}', { name: user.displayName })}
                </Banner>
            ) : null}

            <Button
                label={t('mobile.onboarding.pending_check', 'Check again')}
                onPress={() => {
                    setChecking(true);
                    void refresh().finally(() => setChecking(false));
                }}
                size="lg"
                fullWidth
                loading={checking}
                accessibilityHint={t('mobile.onboarding.pending_check_hint', 'Asks the server whether your account has been approved')}
            />

            <Text variant="caption" tone="tertiary" center>
                {hasOrg
                    ? t(
                          'mobile.onboarding.pending_org_note',
                          'If this has been a while, the fastest route is to ask a colleague who administers Bee Flow.',
                      )
                    : t(
                          'mobile.onboarding.pending_server_note',
                          'Nothing further is needed from you. Approvals are done by hand, so this can take a day.',
                      )}
            </Text>
        </AuthShell>
    );
}

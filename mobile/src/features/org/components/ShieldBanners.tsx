/**
 * What the shield settings cannot say on their own: that a save failed, that
 * no PII detector is installed (so nothing is scanned, whatever the toggles
 * say), that it is installed but down, or that these are the secure defaults
 * rather than a choice. The guard probe matters more than it looks — "on but
 * no detector" used to be indistinguishable from "on and working".
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { Banner, Text } from '@/shared/ui';

import type { GuardStatus, UserShield } from '../model/types';

export function ShieldBanners({
    saveError,
    guard,
    shield,
}: {
    saveError: unknown;
    guard: GuardStatus | null | undefined;
    shield: UserShield | null | undefined;
}) {
    const guardMissing = guard && !guard.configured;
    const guardUnreachable = guard?.configured && !guard.reachable;
    return (
        <>
            {saveError ? <Banner tone="error">{describeError(saveError).message}</Banner> : null}

            {guardMissing ? (
                <Banner tone="warning">
                    No PII detector is installed on this server, so nothing is scanned for
                    personal data — whatever these settings say. An administrator installs it
                    with the <Text variant="code">guard</Text> profile.
                </Banner>
            ) : guardUnreachable ? (
                <Banner tone="error">
                    The PII detector is installed but not answering.{' '}
                    {shield?.piiFailureMode === 'fail_open'
                        ? 'Your messages are going out unscanned, because you have chosen to send anyway when it is down.'
                        : 'Messages are being refused rather than sent unscanned.'}
                </Banner>
            ) : null}

            {shield?.implicitDefault ? (
                <Banner tone="info" icon="Shield">
                    These are Bee Flow&rsquo;s secure defaults, in force because you have never
                    changed them — not an unconfigured state. Changing anything below saves the
                    whole set as your own.
                </Banner>
            ) : null}
        </>
    );
}

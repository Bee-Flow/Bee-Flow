/**
 * What the shield settings cannot say on their own: that a save failed, that
 * no PII detector is installed (so nothing is scanned, whatever the toggles
 * say), that it is installed but down, or that these are the secure defaults
 * rather than a choice. The guard probe matters more than it looks — "on but
 * no detector" used to be indistinguishable from "on and working".
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, Text } from '@/shared/ui';

import type { GuardStatus, UserShield } from '../model/types';

const PROFILE_MARKER = '\u0000';
/** The docker compose profile that installs the detector: an identifier, not copy. */
const GUARD_PROFILE = 'guard';

export function ShieldBanners({
    saveError,
    guard,
    shield,
}: {
    saveError: unknown;
    guard: GuardStatus | null | undefined;
    shield: UserShield | null | undefined;
}) {
    const t = useTranslation();
    const guardMissing = guard && !guard.configured;
    const guardUnreachable = guard?.configured && !guard.reachable;
    // The profile name is drawn in code type inside the sentence, so the sentence is
    // translated whole, with a marker where the name goes.
    const [missingHead = '', missingTail = ''] = t(
        'mobile.org.shield_no_detector',
        'No PII detector is installed on this server, so nothing is scanned for personal data — whatever these settings say. An administrator installs it with the {profile} profile.',
        { profile: PROFILE_MARKER },
    ).split(PROFILE_MARKER);
    return (
        <>
            {saveError ? <Banner tone="error">{describeError(saveError).message}</Banner> : null}

            {guardMissing ? (
                <Banner tone="warning">
                    {missingHead}
                    <Text variant="code">{GUARD_PROFILE}</Text>
                    {missingTail}
                </Banner>
            ) : guardUnreachable ? (
                <Banner tone="error">
                    {shield?.piiFailureMode === 'fail_open'
                        ? t(
                              'mobile.org.shield_down_open',
                              'The PII detector is installed but not answering. Your messages are going out unscanned, because you have chosen to send anyway when it is down.',
                          )
                        : t(
                              'mobile.org.shield_down_closed',
                              'The PII detector is installed but not answering. Messages are being refused rather than sent unscanned.',
                          )}
                </Banner>
            ) : null}

            {shield?.implicitDefault ? (
                <Banner tone="info" icon="Shield">
                    {t(
                        'mobile.org.shield_defaults',
                        'These are Bee Flow’s secure defaults, in force because you have never changed them — not an unconfigured state. Changing anything below saves the whole set as your own.',
                    )}
                </Banner>
            ) : null}
        </>
    );
}

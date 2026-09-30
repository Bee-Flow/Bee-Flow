/**
 * About.
 *
 * The job of this screen is to make a bug report precise. A person writing
 * "the app crashed" is not helpful; a person writing "1.0.0 (build 42),
 * production, sha 9f3a1c, server 8b21de" is. So the version block is
 * selectable, copyable in one tap, and names both halves — the APK and the
 * server it is talking to (from `/api/health`, which reports APP_BUILD_SHA).
 *
 * It also carries the privacy policy and the way to account deletion, both of
 * which Google Play requires to be reachable inside the app.
 */

import React from 'react';

import { GroupedScroll, Screen, ScreenHeader } from '@/shared/ui';

import { AboutCard } from '../components/AboutCard';
import { BuildGroup } from '../components/BuildGroup';
import { PrivacyGroup } from '../components/PrivacyGroup';
import { ReleaseNotesGroup } from '../components/ReleaseNotesGroup';
import { SourceGroups } from '../components/SourceGroups';
import { buildInfo } from '../model/buildInfo';

export function AboutScreen() {
    const info = buildInfo();
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="About" subtitle="Bee Flow for Android" />

            <GroupedScroll>
                <AboutCard profile={info.profile} />
                <BuildGroup info={info} />
                <PrivacyGroup />
                <ReleaseNotesGroup />
                <SourceGroups />
            </GroupedScroll>
        </Screen>
    );
}

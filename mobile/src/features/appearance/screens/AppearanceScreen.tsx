/**
 * Appearance.
 *
 * "Match my phone", Day and Night — the two themes drawn as working
 * miniatures of the app rather than as swatches (components/ThemePreview.tsx
 * says why). Picking one does two things, and both matter:
 *
 *   1. It sets the local preference (ThemeProvider → AsyncStorage), which is
 *      what actually repaints the app, instantly and offline.
 *   2. It writes the same choice to `PUT /api/branding/user`, so the web app
 *      agrees. That call is allowed to fail — an admin can turn user overrides
 *      off (403), and the phone must still let you choose your own theme on
 *      your own device. The screen says so rather than silently diverging.
 */

import React from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { useTheme, type ThemePreference } from '@/core/theme/ThemeProvider';
import { Banner, GroupedScroll, Screen, ScreenHeader } from '@/shared/ui';

import { AppearanceFooter } from '../components/AppearanceFooter';
import { ThemeGrid } from '../components/ThemeGrid';
import { useSaveThemePreset } from '../hooks/mutations';
import { useBranding } from '../hooks/queries';

export function AppearanceScreen() {
    const theme = useTheme();
    const t = useTranslation();
    const branding = useBranding();
    const sync = useSaveThemePreset();

    const choose = (preference: ThemePreference) => {
        theme.setPreference(preference);
        if (preference !== 'system') sync.mutate(preference);
    };

    // Two ways to learn the same thing: the server told us up front
    // (allowUserOverride) or it refused the write (403). Either way the local
    // choice still stands — it just stops at this device.
    const overrideRefused =
        (sync.error instanceof ApiError && sync.error.isForbidden) ||
        branding.data?.allowUserOverride === false;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('settings.appearance', 'Appearance')} subtitle={t('mobile.appearance.subtitle', 'How Bee Flow looks on this phone')} />

            <GroupedScroll>
                {overrideRefused ? (
                    <Banner tone="info" icon="Info">
                        {t('mobile.appearance.override_refused', "Your administrator has fixed the organisation's theme, so your choice stays on this phone and will not follow you to the web app.")}
                    </Banner>
                ) : null}

                <ThemeGrid saving={sync.isPending} onChoose={choose} />
                <AppearanceFooter branding={branding.data} />
            </GroupedScroll>
        </Screen>
    );
}

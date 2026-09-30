/**
 * Language — the language of the app's own words.
 *
 * The same rule the web app follows: an explicit choice, else the
 * organisation's default, else the phone's. The strings come from the
 * SERVER's catalogue, so a string your administrator translated once shows up
 * in the browser and here. The choice is stored by core/i18n and applies at
 * once (useLocalePreference re-resolves it).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { ErrorState, GroupedScroll, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { WorkspaceLocalesGroup } from '../components/WorkspaceLocalesGroup';
import { useLocales } from '../hooks/queries';
import { useLocalePreference } from '../hooks/useLocalePreference';
import { deviceLanguageName } from '../model/deviceLanguage';

export function LanguageScreen() {
    const t = useTranslation();
    const { preference, hydrated, choose } = useLocalePreference();
    const locales = useLocales({ staleTime: 10 * 60_000 });
    const refresh = useUserRefresh(() => locales.refetch());

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('settings.language', 'Language')} />

            <GroupedScroll refresh={refresh}>
                {locales.isLoading || !hydrated ? (
                    <ListSkeleton rows={4} />
                ) : locales.isError ? (
                    <ErrorState error={locales.error} onRetry={() => void locales.refetch()} />
                ) : (
                    <WorkspaceLocalesGroup
                        locales={locales.data ?? []}
                        preference={preference}
                        deviceName={deviceLanguageName()}
                        onChoose={(code) => void choose(code)}
                    />
                )}
            </GroupedScroll>
        </Screen>
    );
}

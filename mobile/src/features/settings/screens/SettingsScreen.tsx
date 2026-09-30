/**
 * Settings — the hub.
 *
 * Deliberately shallow: four short groups of rows, each row a screen. The web
 * app's settings page is a long accordion, which works with a mouse and a tall
 * window and is unusable with a thumb. Splitting it means every sub-screen is
 * short, and the back button always means "up one level". Whether a setting
 * lives on this phone or on the account is said on the screen that holds it.
 */

import React from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { GroupedScroll, Screen, ScreenHeader } from '@/shared/ui';

import { HubAccountGroup } from '../components/HubAccountGroup';
import { HubAppGroup } from '../components/HubAppGroup';
import { HubHelpGroup } from '../components/HubHelpGroup';
import { HubOrgGroup } from '../components/HubOrgGroup';

export function SettingsScreen() {
    const { user } = useAuth();
    const t = useTranslation();
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('settings.title', 'Settings')} subtitle={user?.displayName} />

            <GroupedScroll>
                <HubAppGroup />
                <HubAccountGroup />
                <HubOrgGroup />
                <HubHelpGroup />
            </GroupedScroll>
        </Screen>
    );
}

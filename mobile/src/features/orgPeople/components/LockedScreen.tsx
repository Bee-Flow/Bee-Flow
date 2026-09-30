/**
 * What an org-admin screen shows to someone the server would refuse: who can
 * open it, rather than a 403. `manageUsers` words it for the sections a
 * `manage_users` holder may also read.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, Screen, ScreenHeader } from '@/shared/ui';

export function LockedScreen({ title, manageUsers = false }: { title: string; manageUsers?: boolean }) {
    const t = useTranslation();
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={title} />
            <EmptyState
                icon="Lock"
                title={t('mobile.orgPeople.locked_title', 'Only organisation administrators can open this')}
                message={
                    manageUsers
                        ? t(
                              'mobile.orgPeople.locked_people_message',
                              'Organisation administrators, and people allowed to manage users, see the members here. Ask one if you need access.',
                          )
                        : t(
                              'mobile.orgPeople.locked_message',
                              'This is set by your organisation’s administrators. Ask one if something here needs to change.',
                          )
                }
            />
        </Screen>
    );
}

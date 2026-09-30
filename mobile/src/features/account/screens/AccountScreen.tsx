/**
 * Account — who you are, and what happens to your data.
 *
 * Two things live here: the profile (name and avatar, via `POST
 * /auth/update-profile`) and your data (a GDPR request through the public DSR
 * channel) — including leaving, which, because account deletion has no
 * endpoint, is a DSR erasure request too. The password is on the Security
 * screen, beside two-factor.
 */

import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { GroupedScroll, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { AvatarBlock } from '../components/AvatarBlock';
import { DsrSheet } from '../components/DsrSheet';
import { ProfileGroup } from '../components/ProfileGroup';
import { YourDataGroup } from '../components/YourDataGroup';

export function AccountScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { user } = useAuth();
    const [dsrSheet, setDsrSheet] = useState(false);

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('settings.account', 'Account')} subtitle={user?.email ?? user?.id} />

            <GroupedScroll keyboardShouldPersistTaps="handled">
                <AvatarBlock />
                <ProfileGroup />
                <YourDataGroup onRequest={() => setDsrSheet(true)} />
            </GroupedScroll>

            <DsrSheet
                visible={dsrSheet}
                onClose={() => setDsrSheet(false)}
                defaultEmail={user?.email ?? ''}
                onFiled={() => toast(t('mobile.account.request_filed', 'Request filed'), 'success')}
            />
        </Screen>
    );
}

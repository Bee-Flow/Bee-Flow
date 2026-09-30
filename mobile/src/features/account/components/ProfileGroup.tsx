/**
 * Profile. The display name is writable; the email is NOT — the server has no
 * self-service email change (only an admin can, via PUT /auth/users/:id), so
 * it is shown as a fact rather than as a field that does nothing. The
 * organisation is shown by name; a bare id means nothing to a person, so
 * without a name the row is left out.
 */

import React from 'react';

import { useAccess } from '@/core/access';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';
import { Group, InfoRow } from '@/shared/ui';

import { DisplayNameField } from './DisplayNameField';
import { signInMethod } from '../model/profile';

export function ProfileGroup() {
    const t = useTranslation();
    const { user } = useAuth();
    const organisation = useAccess().organization?.name;
    return (
        <Group
            title={t('settings.profile_section', 'Profile')}
            footer={t('mobile.account.profile_footer', "Your display name is what colleagues see on shared chats and in your organisation's member list.")}
        >
            <DisplayNameField current={user?.displayName ?? ''} />
            <InfoRow label={t('org.email', 'Email')} value={user?.email ?? t('mobile.account.not_set', 'Not set')} selectable />
            <InfoRow label={t('settings.signin_method', 'Sign-in Method')} value={signInMethod(user?.provider)} />
            <InfoRow label={t('mobile.account.role', 'Role')} value={humanise(user?.orgRole ?? user?.role)} />
            {organisation ? (
                <InfoRow label={t('settings.organisation', 'Organisation')} value={organisation} />
            ) : null}
        </Group>
    );
}

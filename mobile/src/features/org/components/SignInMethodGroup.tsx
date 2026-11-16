/**
 * The organisation's preferred sign-in method (web: orgInfo/OrgAuthSection.tsx,
 * AUTH_METHODS in orgInfoShared.tsx). A preference, not a lock: nothing reads
 * it when someone signs in, so every method stays open and the current one is
 * marked.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Group, OptionRow } from '@/shared/ui';

import { AUTH_METHOD_IDS, type AuthMethodId } from '../model/profile';

function methodCopy(t: TranslateFn): Record<AuthMethodId, { label: string; description: string }> {
    return {
        password: {
            label: t('org.password_auth', 'Username & Password'),
            description: t('org.password_auth_desc', 'Users sign in with a username and password.'),
        },
        google: {
            label: t('org.google_auth', 'Sign in with Google'),
            description: t('org.google_auth_desc', 'Users sign in using their Google account.'),
        },
        microsoft: {
            label: t('org.microsoft_auth', 'Sign in with Microsoft'),
            description: t('org.microsoft_auth_desc', 'Users sign in using their Microsoft account.'),
        },
    };
}

export function SignInMethodGroup({
    current,
    saving,
    onChoose,
}: {
    current: string | null;
    saving: boolean;
    onChoose: (method: AuthMethodId) => void;
}) {
    const t = useTranslation();
    const copy = methodCopy(t);
    return (
        <Group>
            {AUTH_METHOD_IDS.map((id) => (
                <OptionRow
                    key={id}
                    testID={`auth-${id}`}
                    label={copy[id].label}
                    description={copy[id].description}
                    selected={current === id}
                    disabled={saving}
                    onPress={() => {
                        if (current !== id) onChoose(id);
                    }}
                />
            ))}
        </Group>
    );
}

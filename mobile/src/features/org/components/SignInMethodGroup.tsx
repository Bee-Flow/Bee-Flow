/**
 * The three sign-in methods (orgInfoShared.jsx AUTH_METHODS, with its keys).
 * Before the choice: every method is open and the web's "choose carefully"
 * note sits under them. After it: the chosen one is marked, the others are
 * disabled, and the web's locked notice says why.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, Group, OptionRow } from '@/shared/ui';

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

/** The web's warning before the one-time choice, as one sentence. */
export function chooseCarefully(t: TranslateFn): string {
    return `${t('org.choose_carefully', 'Choose carefully:')} ${t(
        'org.choose_carefully_desc',
        'Once saved, this cannot be changed. Each user’s data is protected with a unique key that is tied to how they sign in. Switching later would make existing conversations unreadable.',
    )}`;
}

export function SignInMethodGroup({
    current,
    saving,
    onChoose,
}: {
    current: string | null;
    saving: boolean;
    onChoose: (method: AuthMethodId, label: string) => void;
}) {
    const t = useTranslation();
    const copy = methodCopy(t);
    const locked = Boolean(current);
    return (
        <>
            {locked ? (
                <Banner tone="warning" icon="Lock">
                    {`${t('org.signin_locked', 'Sign-in method is locked')}. ${t(
                        'org.signin_locked_desc',
                        'Your conversations are protected using a unique key derived from your sign-in method. Changing how users log in would make existing conversations unreadable, so the sign-in method cannot be changed after it has been set.',
                    )}`}
                </Banner>
            ) : null}
            <Group
                footer={
                    locked
                        ? undefined
                        : chooseCarefully(t)
                }
            >
                {AUTH_METHOD_IDS.map((id) => (
                    <OptionRow
                        key={id}
                        testID={`auth-${id}`}
                        label={copy[id].label}
                        description={
                            current === id ? `${copy[id].description} · ${t('org.active', 'Active')}` : copy[id].description
                        }
                        selected={current === id}
                        disabled={locked || saving}
                        onPress={() => onChoose(id, copy[id].label)}
                    />
                ))}
            </Group>
        </>
    );
}

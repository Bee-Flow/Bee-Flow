/**
 * The password half of the login screen: two fields, the button, and the way
 * to a reset. Editing either field clears the last sign-in error. The fields'
 * values are the screen's, so they survive a trip to the reset form and back.
 * The keyboard's Next goes from the name to the password (without closing the
 * keyboard in between), and its Go on the password signs in.
 */

import React, { useRef } from 'react';
import type { TextInput } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { Button, TextField } from '@/shared/ui';

import { TextLink } from './TextLink';

export interface Credentials {
    username: string;
    password: string;
}

export function PasswordSignIn({
    value,
    onChange,
    onForgot,
}: {
    value: Credentials;
    onChange: (next: Credentials) => void;
    onForgot: () => void;
}) {
    const { signIn, busy, error, clearError } = useAuth();
    const t = useTranslation();
    const passwordField = useRef<TextInput>(null);
    const { username, password } = value;
    const edit = (patch: Partial<Credentials>) => {
        onChange({ ...value, ...patch });
        if (error) clearError();
    };

    const submit = async () => {
        if (!username.trim() || !password) return;
        try {
            await signIn(username.trim(), password);
        } catch {
            // signIn already put a human-readable message on `error`; it
            // rethrows so callers can branch, which this one does not need to.
        }
    };

    return (
        <>
            <TextField
                label={t('mobile.onboarding.email_or_username', 'Email or username')}
                value={username}
                onChangeText={(next) => edit({ username: next })}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                inputMode="email"
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => passwordField.current?.focus()}
                editable={!busy}
            />
            <TextField
                ref={passwordField}
                label={t('login.password', 'Password')}
                value={password}
                onChangeText={(next) => edit({ password: next })}
                secure
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                editable={!busy}
            />
            <Button
                label={t('login.sign_in', 'Sign in')}
                onPress={() => void submit()}
                size="lg"
                fullWidth
                loading={busy}
                disabled={!username.trim() || !password}
            />
            <TextLink
                label={t('login.forgot_password', 'Forgot your password?')}
                onPress={() => {
                    clearError();
                    onForgot();
                }}
            />
        </>
    );
}

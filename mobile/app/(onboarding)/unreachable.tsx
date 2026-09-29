/**
 * "We could not reach your Bee Flow server."
 *
 * The screen that did not exist, and whose absence was a bug rather than an
 * omission. Every failure to reach the server on a cold start used to resolve
 * to `signed-out` — the login form — for a user who was not signed out at all:
 * the cookie was still in the jar, the token still in the keystore, the session
 * still alive on the server. All that had happened was a lift, a tunnel, a
 * hotel Wi-Fi splash page, or a thirty-second deploy.
 *
 * That mattered more than it sounds, because the login form is the one screen a
 * user with no network cannot complete. They could not get in, and the app had
 * told them the reason was their account.
 *
 * So this screen makes one promise and keeps it: nothing about your sign-in has
 * changed, and we will keep trying. It retries by itself every fifteen seconds
 * and again the moment the app is brought back to the foreground (see the
 * AppState handler in AuthProvider), so in the common case — walking out of the
 * lift — the user never touches the button.
 */

import React, { useEffect, useState } from 'react';

import { getServerUrl } from '../../src/api/server';
import { useAuth } from '../../src/auth/AuthProvider';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { Button } from '../../src/ui/Button';
import { Banner } from '../../src/ui/Feedback';
import { Text } from '../../src/ui/Text';

/** Slow enough to be free on a metered connection, fast enough to feel alive. */
const RETRY_EVERY_MS = 15_000;

export default function UnreachableScreen() {
    const { refresh, signOut, forgetServer } = useAuth();
    const [trying, setTrying] = useState(false);
    const server = getServerUrl();

    useEffect(() => {
        const timer = setInterval(() => {
            void refresh();
        }, RETRY_EVERY_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    return (
        <AuthShell
            icon="wifi-off"
            tone="warning"
            title="Can't reach your server"
            subtitle="You are still signed in. This is the connection, not your account — nothing has been logged out and nothing needs to be set up again."
            footer={
                <TextLink
                    label="Use a different server"
                    tone="tertiary"
                    onPress={() => void forgetServer()}
                />
            }
        >
            {server ? (
                <Banner tone="info" icon="server">
                    {`Trying ${server}`}
                </Banner>
            ) : null}

            <Button
                label="Try again"
                onPress={() => {
                    setTrying(true);
                    void refresh().finally(() => setTrying(false));
                }}
                size="lg"
                fullWidth
                loading={trying}
                accessibilityHint="Asks your Bee Flow server again"
            />

            <Text variant="caption" tone="tertiary" center>
                Retrying on its own every few seconds, and again as soon as you come back to the
                app.
            </Text>

            <TextLink label="Sign out instead" tone="tertiary" onPress={() => void signOut()} />
        </AuthShell>
    );
}

/**
 * "Which Bee Flow?" — the first screen anyone ever sees.
 *
 * The web app never asks this: it is served BY the server, so its API base is
 * a relative path. An APK has no such anchor. The same binary is installed by
 * a customer of the hosted service, by a company on its own domain, and by
 * someone who ran `./selfhost.sh` on a laptop half an hour ago and found this
 * app on a GitHub release page. That last person is why the screen explains
 * what Bee Flow is in one sentence before asking for anything.
 *
 * Two rules the screen enforces rather than trusts:
 *
 *   1. Nothing is remembered until /api/health has answered. Storing an
 *      unverified URL means every later failure — a login that hangs, a chat
 *      that will not load — presents as a bug in the app rather than as a typo
 *      here.
 *   2. Cleartext to a public host is refused unless the user says so in as
 *      many words. `http://` on 192.168.x.x is a self-hoster on their own LAN;
 *      `http://` on a public name is a password sent in the clear to whoever
 *      is on the path, and this is a privacy product.
 */

import { Feather } from '@expo/vector-icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import {
    checkHealth,
    isInsecure,
    isPrivateHost,
    normaliseServerUrl,
} from '../../src/api/server';
import { useAuth } from '../../src/auth/AuthProvider';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { Banner } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { Text } from '../../src/ui/Text';

/** The hosted instance, offered as a shortcut rather than as a default. */
const CLOUD_URL = 'https://beeflow.nl';

export default function ChooseServerScreen() {
    const theme = useTheme();
    const { chooseServer } = useAuth();

    const [input, setInput] = useState('');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** A normalised cleartext URL awaiting an explicit "yes, I mean it". */
    const [insecureUrl, setInsecureUrl] = useState<string | null>(null);

    const connect = async (raw: string, allowInsecure = false) => {
        setError(null);
        setInsecureUrl(null);

        const url = normaliseServerUrl(raw);
        if (!url) {
            setError('That does not look like a web address. Try something like beeflow.example.com.');
            return;
        }

        if (isInsecure(url) && !isPrivateHost(url) && !allowInsecure) {
            setInsecureUrl(url);
            return;
        }

        setChecking(true);
        try {
            const health = await checkHealth(url);
            if (!health.ok) {
                setError(health.error ?? 'That address did not answer.');
                return;
            }
            // Only now is it worth remembering. chooseServer persists it and
            // re-resolves the auth stage, which moves the user on.
            await chooseServer(url);
        } finally {
            setChecking(false);
        }
    };

    if (insecureUrl) {
        const secure = insecureUrl.replace(/^http:/i, 'https:');
        return (
            <AuthShell
                icon="alert-triangle"
                tone="error"
                title="That connection is not encrypted"
                subtitle={`${insecureUrl} is a public address served over plain http. Your password and everything you write would travel in the clear, readable by anyone between this phone and that server.`}
            >
                <Button
                    label="Try it over https instead"
                    onPress={() => {
                        setInput(secure);
                        void connect(secure);
                    }}
                    size="lg"
                    fullWidth
                />
                <Button
                    label="Connect anyway, unencrypted"
                    onPress={() => void connect(insecureUrl, true)}
                    variant="destructive"
                    fullWidth
                    loading={checking}
                    accessibilityHint="Sends your password unencrypted over the internet"
                />
                <TextLink
                    label="Use a different address"
                    tone="tertiary"
                    onPress={() => setInsecureUrl(null)}
                />
                <Text variant="caption" tone="tertiary" center>
                    Plain http is fine on a home or office network — 192.168.x.x,
                    10.x.x.x or localhost. This address is not one of those.
                </Text>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            icon="server"
            title="Connect to your Bee Flow"
            subtitle="Bee Flow is a private AI workspace that runs on your own server, or on one your company runs. Tell the app where yours lives."
            footer={
                <Text variant="caption" tone="tertiary" center>
                    You can change this later in Settings.
                </Text>
            }
        >
            {error ? <Banner tone="error">{error}</Banner> : null}

            <TextField
                label="Server address"
                value={input}
                onChangeText={setInput}
                placeholder="beeflow.example.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                inputMode="url"
                autoComplete="url"
                returnKeyType="go"
                onSubmitEditing={() => void connect(input)}
                editable={!checking}
                hint="https:// is assumed if you leave it off."
            />

            <Button
                label="Connect"
                onPress={() => void connect(input)}
                size="lg"
                fullWidth
                loading={checking}
                disabled={input.trim().length === 0}
            />

            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingTop: theme.spacing.sm,
                }}
            >
                <Feather name="cloud" size={16} color={theme.colors.textMuted} />
                <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
                    Using the hosted service rather than your own server?
                </Text>
            </View>
            <Button
                label="Use Bee Flow Cloud"
                onPress={() => {
                    setInput(CLOUD_URL);
                    void connect(CLOUD_URL);
                }}
                variant="secondary"
                fullWidth
                disabled={checking}
            />
        </AuthShell>
    );
}

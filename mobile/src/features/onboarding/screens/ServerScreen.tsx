/**
 * "Which Bee Flow?" — the first screen anyone ever sees.
 *
 * The web app never asks this: it is served BY the server, so its API base is
 * a relative path. An APK has no such anchor. The same binary is installed by
 * a customer of the hosted service, by a company on its own domain, and by
 * someone who ran `./selfhost.sh` on a laptop half an hour ago and found this
 * app on a GitHub release page. That last person is why the screen explains
 * what Bee Flow is in one sentence before asking for anything. The rules for
 * what may be remembered are in useConnectServer.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Icon, Text, TextField } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { InsecureServerWarning } from '../components/InsecureServerWarning';
import { EXAMPLE_HOST, useConnectServer } from '../hooks/useConnectServer';

/** The hosted instance, offered as a shortcut rather than as a default. */
const CLOUD_URL = 'https://beeflow.nl';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        cloud: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.sm },
        cloudText: { flex: 1 },
    });

export function ServerScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [input, setInput] = useState('');
    const server = useConnectServer();
    const use = (url: string) => {
        setInput(url);
        void server.connect(url);
    };

    if (server.insecureUrl) {
        const insecure = server.insecureUrl;
        return (
            <InsecureServerWarning
                url={insecure}
                checking={server.checking}
                onTryHttps={() => use(insecure.replace(/^http:/i, 'https:'))}
                onConnectAnyway={() => void server.connect(insecure, true)}
                onBack={server.dismissInsecure}
            />
        );
    }

    return (
        <AuthShell
            icon="Server"
            title={t('mobile.onboarding.server_title', 'Connect to your Bee Flow')}
            subtitle={t(
                'mobile.onboarding.server_intro',
                'Bee Flow is a private AI workspace that runs on your own server, or on one your company runs. Tell the app where yours lives.',
            )}
            footer={
                <Text variant="caption" tone="tertiary" center>
                    {t('mobile.onboarding.server_later', 'You can change this later in Settings.')}
                </Text>
            }
        >
            {server.error ? <Banner tone="error">{server.error}</Banner> : null}

            <TextField
                label={t('mobile.onboarding.server_address', 'Server address')}
                value={input}
                onChangeText={setInput}
                placeholder={EXAMPLE_HOST}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                inputMode="url"
                autoComplete="url"
                returnKeyType="go"
                onSubmitEditing={() => void server.connect(input)}
                editable={!server.checking}
                hint={t('mobile.onboarding.server_https_hint', 'https:// is assumed if you leave it off.')}
            />

            <Button
                label={t('mobile.onboarding.server_connect', 'Connect')}
                onPress={() => void server.connect(input)}
                size="lg"
                fullWidth
                loading={server.checking}
                disabled={input.trim().length === 0}
            />

            <View style={styles.cloud}>
                <Icon name="Cloud" size={16} color={theme.colors.textMuted} />
                <Text variant="caption" tone="tertiary" style={styles.cloudText}>
                    {t('mobile.onboarding.server_cloud_question', 'Using the hosted service rather than your own server?')}
                </Text>
            </View>
            <Button
                label={t('mobile.onboarding.server_cloud', 'Use Bee Flow Cloud')}
                onPress={() => use(CLOUD_URL)}
                variant="secondary"
                fullWidth
                disabled={server.checking}
            />
        </AuthShell>
    );
}

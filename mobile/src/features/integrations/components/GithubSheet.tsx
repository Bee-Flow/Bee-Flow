/**
 * Connect GitHub with a personal access token — the one connector that can be
 * completed inside the app, because the server validates the token against
 * api.github.com before storing it and answers 400 with a readable reason.
 */

import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { Button, Text, TextField } from '@/shared/ui';

import { useConnectGithub } from '../hooks/mutations';

export function GithubSheet({
    visible,
    onClose,
    onConnected,
}: {
    visible: boolean;
    onClose: () => void;
    onConnected: () => void;
}) {
    const t = useTranslation();
    const [token, setToken] = useState('');
    const connect = useConnectGithub();

    const submit = () =>
        connect.mutate(token.trim(), {
            onSuccess: () => {
                setToken('');
                onConnected();
            },
        });

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.integrations.github_title', 'Connect GitHub')}
            subtitle={t('mobile.integrations.github_subtitle', 'A personal access token, checked before it is stored')}
            submitLabel={t('automations.add_step_menu.connect', 'Connect')}
            onSubmit={submit}
            canSubmit={token.trim().length > 0}
            submitting={connect.isPending}
            error={connect.isError ? connect.error : undefined}
        >
            <Text variant="caption" tone="tertiary">
                {t(
                    'mobile.integrations.github_help',
                    'Create a token at github.com under Settings → Developer settings → Personal access tokens, with the scopes you want Bee Flow to have. Bee Flow validates it against GitHub before storing it encrypted, and never returns it again.',
                )}
            </Text>
            <TextField
                label={t('connections.field_pat', 'Personal access token')}
                value={token}
                onChangeText={setToken}
                secure
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('mobile.integrations.github_token_placeholder', 'ghp_…')}
            />
            <Button
                label={t('mobile.integrations.github_open_settings', 'Open GitHub token settings')}
                variant="ghost"
                onPress={() => void WebBrowser.openBrowserAsync('https://github.com/settings/tokens')}
            />
        </FormSheet>
    );
}

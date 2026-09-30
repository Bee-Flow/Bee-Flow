/**
 * Connect GitHub with a personal access token — the one connector that can be
 * completed inside the app, because the server validates the token against
 * api.github.com before storing it and answers 400 with a readable reason.
 */

import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';

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
            title="Connect GitHub"
            subtitle="A personal access token, checked before it is stored"
            submitLabel="Connect"
            onSubmit={submit}
            canSubmit={token.trim().length > 0}
            submitting={connect.isPending}
            error={connect.isError ? connect.error : undefined}
        >
            <Text variant="caption" tone="tertiary">
                Create a token at github.com under Settings → Developer settings → Personal
                access tokens, with the scopes you want Bee Flow to have. Bee Flow validates it
                against GitHub before storing it encrypted, and never returns it again.
            </Text>
            <TextField
                label="Personal access token"
                value={token}
                onChangeText={setToken}
                secure
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="ghp_…"
            />
            <Button
                label="Open GitHub token settings"
                variant="ghost"
                onPress={() => void WebBrowser.openBrowserAsync('https://github.com/settings/tokens')}
            />
        </FormSheet>
    );
}

/**
 * The n8n Connection tab (N8nSection.jsx ConnectionTab): the access check once
 * n8n is configured, the instance URL and the API key (a secret the server
 * never shows back: only a newly typed one is sent), Save and Test. A test
 * uses what is typed, falling back to what is stored.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, Button, Group, TextField, useToast } from '@/shared/ui';

import { N8nAccessCheck } from './N8nAccessCheck';
import { useEnableN8nForOrg, useSaveN8nConfig, useTestN8n } from '../hooks/n8nMutations';
import { useN8nDiagnostics } from '../hooks/n8nQueries';
import type { N8nConfig, N8nTestResult } from '../model/n8nTypes';

const styles = StyleSheet.create({
    fields: { padding: 12, gap: 12 },
    actions: { flexDirection: 'row', gap: 8 },
});

export function N8nConnectionPane({
    config,
    test,
    onTested,
    onPermissions,
}: {
    config: N8nConfig;
    test: N8nTestResult | null;
    onTested: (result: N8nTestResult | null) => void;
    onPermissions: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const [url, setUrl] = useState(config.n8nUrl);
    const [apiKey, setApiKey] = useState('');
    const diag = useN8nDiagnostics(config.configured);
    const save = useSaveN8nConfig();
    const tester = useTestN8n();
    const enable = useEnableN8nForOrg();
    const creds = () => ({ ...(url ? { n8nUrl: url } : {}), ...(apiKey ? { apiKey } : {}) });

    const onSave = async () => {
        try {
            await save.mutateAsync({ n8nUrl: url, ...(apiKey ? { apiKey } : {}) });
            setApiKey('');
            onTested(null);
            toast(t('mobile.orgIntegrations.n8n_saved', 'Connection saved'), 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };
    const onTest = async () => {
        try {
            onTested(await tester.mutateAsync(creds()));
        } catch (err) {
            onTested({ ok: false, activeWebhookCount: null, status: null, error: describeError(err).message });
        }
    };
    const onEnable = () =>
        enable.mutate(undefined, {
            onSuccess: () => toast(t('mobile.orgIntegrations.n8n_enabled_org', 'n8n enabled for this organisation'), 'success'),
            onError: (err) => toast(describeError(err).message, 'error'),
        });

    return (
        <>
            {config.configured && diag.data ? (
                <N8nAccessCheck diag={diag.data} enabling={enable.isPending} onEnable={onEnable} onPermissions={onPermissions} />
            ) : null}
            <Group title={t('mobile.orgIntegrations.n8n_connection', 'Connection')}>
                <View style={styles.fields}>
                    <TextField
                        testID="n8n-url"
                        label={t('mobile.orgIntegrations.n8n_url', 'n8n Instance URL')}
                        placeholder={t('mobile.orgIntegrations.n8n_url_ph', 'https://n8n.yourdomain.com')}
                        hint={t('mobile.orgIntegrations.n8n_url_hint', 'Base URL of your n8n instance. /api/v1 is appended automatically.')}
                        keyboardType="url"
                        autoCapitalize="none"
                        value={url}
                        onChangeText={setUrl}
                    />
                    <TextField
                        testID="n8n-key"
                        label={t('mobile.orgIntegrations.n8n_key', 'API Key')}
                        placeholder={config.hasApiKey ? '••••••••••••••••' : t('mobile.orgIntegrations.n8n_key_placeholder', 'Enter your n8n API key')}
                        hint={t('mobile.orgIntegrations.n8n_key_hint', 'Generate at n8n → Settings → API → Create API Key. Stored encrypted.')}
                        secure
                        value={apiKey}
                        onChangeText={setApiKey}
                    />
                    <View style={styles.actions}>
                        <Button
                            testID="n8n-save"
                            label={t('mobile.orgIntegrations.n8n_save', 'Save Connection')}
                            loading={save.isPending}
                            disabled={!url}
                            onPress={() => void onSave()}
                        />
                        <Button
                            testID="n8n-test"
                            label={t('mobile.orgIntegrations.n8n_test', 'Test Connection')}
                            variant="secondary"
                            loading={tester.isPending}
                            disabled={!url || (!apiKey && !config.hasApiKey)}
                            onPress={() => void onTest()}
                        />
                    </View>
                </View>
            </Group>
            {test && !test.ok ? <Banner tone="error">{test.error || `HTTP ${test.status ?? '?'}`}</Banner> : null}
        </>
    );
}

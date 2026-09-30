/**
 * A public address over plain http. The safe answer (try https) is the big
 * button; connecting anyway is possible, destructive-toned, and says what it
 * costs.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, Text } from '@/shared/ui';

import { AuthShell } from './AuthShell';
import { TextLink } from './TextLink';

export function InsecureServerWarning({
    url,
    checking,
    onTryHttps,
    onConnectAnyway,
    onBack,
}: {
    url: string;
    checking: boolean;
    onTryHttps: () => void;
    onConnectAnyway: () => void;
    onBack: () => void;
}) {
    const t = useTranslation();
    return (
        <AuthShell
            icon="TriangleAlert"
            tone="error"
            title={t('mobile.onboarding.insecure_title', 'That connection is not encrypted')}
            subtitle={t(
                'mobile.onboarding.insecure_intro',
                '{url} is a public address served over plain http. Your password and everything you write would travel in the clear, readable by anyone between this phone and that server.',
                { url },
            )}
        >
            <Button label={t('mobile.onboarding.insecure_try_https', 'Try it over https instead')} onPress={onTryHttps} size="lg" fullWidth />
            <Button
                label={t('mobile.onboarding.insecure_connect', 'Connect anyway, unencrypted')}
                onPress={onConnectAnyway}
                variant="danger"
                fullWidth
                loading={checking}
                accessibilityHint={t('mobile.onboarding.insecure_connect_hint', 'Sends your password unencrypted over the internet')}
            />
            <TextLink label={t('mobile.onboarding.insecure_back', 'Use a different address')} tone="tertiary" onPress={onBack} />
            <Text variant="caption" tone="tertiary" center>
                {t(
                    'mobile.onboarding.insecure_lan_note',
                    'Plain http is fine on a home or office network — 192.168.x.x, 10.x.x.x or localhost. This address is not one of those.',
                )}
            </Text>
        </AuthShell>
    );
}

/**
 * What stands between a provider and its meetings, one banner per reason, in
 * the web's words: Talk's recording backend missing, Google not connected or
 * connected without the Meet permissions, or a provider that did not answer.
 *
 * The web reconnects Google in a popup; the phone sends the person to
 * Integrations, where Google is connected.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, Button, Text } from '@/shared/ui';

import type { Upcoming } from '../hooks/useUpcoming';

function ProviderError({ title, error }: { title: string; error: unknown }) {
    return (
        <Banner tone="error">
            <Text variant="caption" weight="semibold">
                {title}
            </Text>
            <Text variant="caption" tone="secondary">
                {describeError(error).message}
            </Text>
        </Banner>
    );
}

export function UpcomingBanners({ upcoming }: { upcoming: Upcoming }) {
    const t = useTranslation();
    const router = useRouter();
    const { talk, meet, connection } = upcoming;
    const toIntegrations = (label: string) => (
        <Button label={label} variant="ghost" size="sm" onPress={() => router.push('/integrations')} />
    );
    return (
        <>
            {talk.data && !talk.data.recordingEnabled ? (
                <Banner tone="warning">
                    {t(
                        'meetings.upcoming_talk_backend',
                        "The Nextcloud Talk recording backend isn't configured, so auto-record is unavailable. You can still import finished recordings.",
                    )}
                </Banner>
            ) : null}
            {connection && !connection.googleConnected ? (
                <Banner tone="info" icon="Video" action={toIntegrations(t('meetings.upcoming_settings_integrations', 'Settings → Integrations'))}>
                    {t('meetings.upcoming_connect_google', 'Connect Google Workspace to see your Meet meetings here —')}
                </Banner>
            ) : null}
            {connection && connection.googleConnected && !connection.meetScopesGranted ? (
                <Banner tone="warning" action={toIntegrations(t('meetings.upcoming_reconnect', 'Reconnect'))}>
                    {t(
                        'meetings.upcoming_meet_scopes',
                        "Your Google connection doesn't include Meet permissions yet — reconnect to enable auto-import.",
                    )}
                </Banner>
            ) : null}
            {talk.isError ? (
                <ProviderError title={t('meetings.upcoming_talk_failed', "Couldn't load Nextcloud Talk meetings")} error={talk.error} />
            ) : null}
            {meet.isError ? (
                <ProviderError title={t('meetings.upcoming_meet_failed', "Couldn't load Google Meet meetings")} error={meet.error} />
            ) : null}
        </>
    );
}

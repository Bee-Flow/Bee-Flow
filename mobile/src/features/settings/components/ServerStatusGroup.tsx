/** The server this app is on: its address, whether it answers, and its version. */

import React from 'react';

import { isInsecure } from '@/core/api/server';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { Badge, BadgeRow, Group, InfoRow, NoteRow, Spinner, Text } from '@/shared/ui';

import { useServerHealth } from '../hooks/queries';

export function ServerStatusGroup({ current }: { current: string | null }) {
    const t = useTranslation();
    const { user } = useAuth();
    // Polled rather than fetched once: this is the screen someone opens WHILE
    // things are broken.
    const health = useServerHealth({ refetchInterval: 30_000 });
    const ok = Boolean(health.data?.ok);
    return (
        <Group
            title={t('mobile.settings.connected_to', 'Connected to')}
            footer={t('mobile.settings.server_footer', 'Everything in Bee Flow — your chats, your files, your encryption key — belongs to this server. Nothing is stored anywhere else.')}
        >
            <InfoRow label={t('mobile.settings.address', 'Address')} value={current ?? t('mobile.settings.not_configured', 'Not configured')} selectable />
            <BadgeRow label={t('mobile.settings.reachable', 'Reachable')}>
                {health.isFetching && !health.data ? (
                    <Spinner />
                ) : (
                    <Badge
                        label={ok ? t('mobile.settings.healthy', 'Healthy') : t('mobile.settings.unreachable', 'Unreachable')}
                        tone={ok ? 'success' : 'error'}
                    />
                )}
            </BadgeRow>
            {health.data && !health.data.ok && health.data.error ? (
                <NoteRow>
                    <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                        {health.data.error}
                    </Text>
                </NoteRow>
            ) : null}
            <InfoRow
                label={t('mobile.settings.server_version', 'Server version')}
                value={health.data?.appVersion || t('mobile.settings.not_reported', 'Not reported')}
                selectable
            />
            <InfoRow label={t('mobile.settings.connection', 'Connection')} value={current && isInsecure(current) ? 'HTTP' : 'HTTPS'} />
            {user ? <InfoRow label={t('mobile.settings.signed_in_as', 'Signed in as')} value={user.displayName} /> : null}
        </Group>
    );
}

/**
 * A notification row's text under the title: the body (a preview, or all of
 * it when expanded), when and what kind, and what the phone cannot do about it.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { connectorLabel } from '@/features/integrations';
import { humanise } from '@/shared/lib/display';
import { openRoute } from '@/shared/navigation';
import { Badge, Button, Text } from '@/shared/ui';

import { parseReauthToken, previewOf } from '../model/format';
import { RESULT_CATEGORIES, type AppNotification, type CategoryPresentation } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        meta: {
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.xxs,
        },
        reason: { flex: 1 },
        follow: { alignSelf: 'flex-start', marginTop: theme.spacing.xs },
    });

/** The expanded result's way on: the automation it came from, or the Cowork item. */
function FollowButton({ category, onPress }: { category: string; onPress: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const label = category === 'cowork' ? t('mobile.notifications.open_cowork', 'Open Cowork item') : t('mobile.notifications.open_automation', 'Open automation');
    return (
        <View style={styles.follow}>
            <Button size="sm" variant="secondary" iconName="ArrowRight" label={label} onPress={onPress} testID="notification-follow" />
        </View>
    );
}

/**
 * An automation whose credentials lapsed writes `automation_reauth:<provider>` at the
 * head of its body. The provider is said by name ("Google Workspace", not
 * "google"), and the way on is the phone's own Integrations screen, where the
 * connector reconnects — not a trip to the web app.
 */
function ReauthNote({ provider }: { provider: string }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const name = connectorLabel(provider) ?? humanise(provider);
    return (
        <>
            <Text variant="caption" tone="warning">
                {t('mobile.notifications.reauth_body', 'Connect {provider} again to restart this automation.', { provider: name })}
            </Text>
            <View style={styles.follow}>
                <Button
                    size="sm"
                    variant="secondary"
                    iconName="ArrowRight"
                    label={t('mobile.notifications.reauth_action', 'Reconnect {provider}', { provider: name })}
                    onPress={() => openRoute(router, '/integrations')}
                    testID="notification-reauth"
                />
            </View>
        </>
    );
}

export function NotificationRowBody({
    notification,
    expanded,
    presentation,
    unavailableReason,
    onFollow,
}: {
    notification: AppNotification;
    expanded: boolean;
    presentation: CategoryPresentation;
    unavailableReason?: string;
    /** Where an expanded result row leads, when it leads anywhere. */
    onFollow?: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { provider, body } = parseReauthToken(notification.message);
    const isResult = RESULT_CATEGORIES.has(notification.category);

    return (
        <>
            {body ? (
                <Text variant="caption" tone="tertiary" numberOfLines={expanded ? undefined : 2}>
                    {expanded ? body : previewOf(body)}
                </Text>
            ) : null}

            <View style={styles.meta}>
                <Text variant="label" tone="tertiary">
                    {timeAgo(notification.created_at, { suffix: true })}
                </Text>
                <Badge label={presentation.label} tone={presentation.tone} />
                {unavailableReason ? (
                    <Text variant="label" tone="tertiary" style={styles.reason}>
                        {unavailableReason}
                    </Text>
                ) : null}
            </View>

            {provider ? <ReauthNote provider={provider} /> : null}

            {expanded && onFollow ? <FollowButton category={notification.category} onPress={onFollow} /> : null}

            {isResult && !expanded && body.length > 140 ? (
                <Text variant="label" tone="accent">
                    {t('mobile.notifications.tap_full_result', 'Tap to read the full result')}
                </Text>
            ) : null}
        </>
    );
}

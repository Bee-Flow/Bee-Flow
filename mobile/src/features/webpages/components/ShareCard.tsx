/**
 * One external link: its state, its views, the address (when it can still be
 * shown), and — for the owner of a live link — refresh and revoke.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { formatWhen, timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Badge, Button, Icon, Text } from '@/shared/ui';

import { LinkActions } from './LinkActions';
import { isShareLive, shareStatus } from '../model/format';
import type { WebpageShare } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        card: { padding: theme.spacing.lg, gap: theme.spacing.md },
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        grow: { flex: 1 },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
    });

/**
 * `url` is null whenever the raw token cannot be recovered: revoked, expired,
 * or a row created before tokens were encrypted at rest. Nothing to retry —
 * the address is gone for good and a new link is the only way back.
 */
function ShareAddress({ share, live }: { share: WebpageShare; live: boolean }) {
    const t = useTranslation();
    if (share.url) {
        return (
            <LinkActions
                url={share.url}
                shareTitle={share.title || t('mobile.webpages.link.share_title', 'Bee Flow page')}
            />
        );
    }
    return (
        <Text variant="caption" tone="tertiary">
            {live
                ? t(
                      'mobile.webpages.link.legacy',
                      'This link was made before Bee Flow could show addresses again. Create a new one to get a copyable link.',
                  )
                : t('mobile.webpages.link.dead', 'This address no longer works.')}
        </Text>
    );
}

export function ShareCard({
    share,
    owned,
    busy,
    onRefresh,
    onRevoke,
}: {
    share: WebpageShare;
    owned: boolean;
    busy: boolean;
    onRefresh: () => void;
    onRevoke: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const status = shareStatus(share);
    const live = isShareLive(share);

    return (
        <View style={styles.card}>
            <View style={styles.row}>
                <Badge label={status.label} tone={status.tone} />
                <Text variant="caption" tone="tertiary" style={styles.grow} numberOfLines={1}>
                    {nOf(t, 'mobile.webpages.link.views', share.viewCount, ['{count} view', '{count} views'])}
                    {share.lastViewedAt
                        ? ` · ${t('mobile.webpages.link.last_viewed', 'last {when}', { when: timeAgo(share.lastViewedAt) })}`
                        : ''}
                </Text>
            </View>

            {share.expiresAt && live ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.webpages.link.expires', 'Expires {when}', { when: formatWhen(share.expiresAt) })}
                </Text>
            ) : null}

            <ShareAddress share={share} live={live} />

            {owned && live ? (
                <View style={styles.actions}>
                    <Button
                        label={t('mobile.webpages.link.refresh', 'Refresh')}
                        variant="ghost"
                        loading={busy}
                        onPress={onRefresh}
                        icon={<Icon name="RefreshCw" size={16} color={theme.colors.textSecondary} />}
                        accessibilityHint={t(
                            'mobile.webpages.link.refresh_hint',
                            "Publishes the page's current content to this same address",
                        )}
                    />
                    <Button label={t('mobile.webpages.link.revoke', 'Revoke')} variant="ghost" onPress={onRevoke} />
                </View>
            ) : null}
        </View>
    );
}

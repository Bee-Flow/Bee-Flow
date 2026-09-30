/**
 * External links: a sanitized, JavaScript-free snapshot at /share/<token> for
 * whoever holds the address. A page has a handful of links, so they are drawn
 * in one card rather than a virtualised list.
 */

import React from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Card, Divider, Section, Text, useToast } from '@/shared/ui';

import { ShareCard } from './ShareCard';
import { useRefreshWebpageShare } from '../hooks/mutations';
import type { useWebpageShares } from '../hooks/queries';
import type { WebpageShare } from '../model/types';

function ShareList({
    pageId,
    shares,
    owned,
    onRevoke,
}: {
    pageId: string;
    shares: WebpageShare[];
    owned: boolean;
    onRevoke: (share: WebpageShare) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const refreshLink = useRefreshWebpageShare(pageId, {
        onSuccess: () => toast(t('mobile.webpages.link.refreshed', 'Snapshot updated'), 'success'),
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    return (
        <Card padded={false}>
            {shares.map((share, index) => (
                <View key={share.id}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <ShareCard
                        share={share}
                        owned={owned}
                        busy={refreshLink.isPending && refreshLink.variables === share.id}
                        onRefresh={() => refreshLink.mutate(share.id)}
                        onRevoke={() => onRevoke(share)}
                    />
                </View>
            ))}
        </Card>
    );
}

export function SharesSection({
    pageId,
    shares,
    owned,
    onNewLink,
    onRevoke,
}: {
    pageId: string;
    shares: ReturnType<typeof useWebpageShares>;
    owned: boolean;
    onNewLink: () => void;
    onRevoke: (share: WebpageShare) => void;
}) {
    const t = useTranslation();
    const rows = shares.data ?? [];
    let body: React.ReactNode;
    if (shares.isError) {
        const described = describeError(shares.error);
        body = <Banner tone={described.retryable ? 'error' : 'info'}>{described.message}</Banner>;
    } else if (rows.length === 0) {
        body = (
            <Card>
                <Text variant="body" tone="tertiary">
                    {owned
                        ? t(
                              'mobile.webpages.link.none_owner',
                              'No external links yet. One gives anyone who holds the address a read-only copy of this page.',
                          )
                        : t(
                              'mobile.webpages.link.none_viewer',
                              'The owner has not created any external links for this page.',
                          )}
                </Text>
            </Card>
        );
    } else {
        body = <ShareList pageId={pageId} shares={rows} owned={owned} onRevoke={onRevoke} />;
    }

    return (
        <Section
            title={t('mobile.webpages.link.section', 'External links')}
            subtitle={t(
                'mobile.webpages.link.section_hint',
                'A snapshot of the page, without its JavaScript, for people outside Bee Flow',
            )}
            action={
                owned ? (
                    <Button label={t('mobile.webpages.link.new', 'New link')} variant="ghost" onPress={onNewLink} />
                ) : undefined
            }
        >
            {body}
        </Section>
    );
}

/**
 * Public: the page's own address, /w/<slug>, for people outside Bee Flow —
 * the fourth audience row of the web's Audience panel. Separate from the
 * internal publish above it and from the loose external links below it: this
 * is the one address that belongs to the page, and it keeps working across
 * edits and changes of access.
 *
 * A public state the server could not read is said as such (`known`), never
 * shown as "not public": that would be a claim about exposure made from a
 * failed read.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { apiUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Badge, Banner, Button, Card, ErrorState, LoadingState, Section, Text, useToast } from '@/shared/ui';

import { LinkActions } from './LinkActions';
import { PublicSheet } from './PublicSheet';
import { useSetPublic } from '../hooks/audienceMutations';
import { useWebpageAudience } from '../hooks/queries';
import type { WebpageAudience } from '../model/audienceTypes';
import { publicFacts } from '../model/publicFacts';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
        state: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        grow: { flex: 1 },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
    });

function PublicFacts({ audience }: { audience: WebpageAudience }) {
    const t = useTranslation();
    const facts = publicFacts(audience, t);
    const url = audience.address ? (audience.address.url ?? apiUrl(audience.address.path)) : null;
    return (
        <>
            <Text variant="caption" tone="tertiary">
                {facts.join(' · ')}
            </Text>
            {url ? <LinkActions url={url} /> : null}
        </>
    );
}

function PublicCard({ pageId, audience }: { pageId: string; audience: WebpageAudience }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const confirm = useConfirm();
    const { toast } = useToast();
    const [editing, setEditing] = useState(false);
    const off = useSetPublic(pageId, { onError: (err) => toast(describeError(err).message, 'error') });
    const on = audience.public.on;

    const stop = async () => {
        const ok = await confirm({
            title: t('mobile.webpages.public.stop_title', 'Stop sharing publicly?'),
            message: t(
                'mobile.webpages.public.stop_body',
                'The address stops working at once. Anyone you sent it to gets a not-found page.',
            ),
            confirmLabel: t('mobile.webpages.public.stop', 'Stop sharing'),
        });
        if (ok) off.mutate({ on: false, publicColumns: {}, accessMode: 'unlisted' });
    };

    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.state}>
                    <Badge
                        label={
                            on
                                ? t('mobile.webpages.public.on', 'Public')
                                : t('mobile.webpages.public.off', 'Not public')
                        }
                        tone={on ? 'accent' : 'neutral'}
                    />
                </View>
                {audience.public.known ? null : (
                    <Banner tone="warning">
                        {t(
                            'mobile.webpages.public.unknown',
                            'The current public address could not be read. Nothing was changed.',
                        )}
                    </Banner>
                )}
                {on ? <PublicFacts audience={audience} /> : null}
                <View style={styles.actions}>
                    <Button
                        label={
                            on
                                ? t('mobile.webpages.public.change', 'Change')
                                : t('mobile.webpages.public.make', 'Make public')
                        }
                        variant={on ? 'secondary' : 'primary'}
                        onPress={() => setEditing(true)}
                        style={styles.grow}
                    />
                    {on ? (
                        <Button
                            label={t('mobile.webpages.public.stop', 'Stop sharing')}
                            variant="ghost"
                            loading={off.isPending}
                            onPress={() => void stop()}
                        />
                    ) : null}
                </View>
            </View>
            {editing ? (
                <PublicSheet pageId={pageId} audience={audience} visible onClose={() => setEditing(false)} />
            ) : null}
        </Card>
    );
}

export function PublicSection({ pageId }: { pageId: string }) {
    const t = useTranslation();
    const audience = useWebpageAudience(pageId);
    let body: React.ReactNode;
    if (audience.isLoading) body = <LoadingState />;
    else if (audience.isError || !audience.data)
        body = <ErrorState error={audience.error} onRetry={() => void audience.refetch()} />;
    else body = <PublicCard pageId={pageId} audience={audience.data} />;
    return (
        <Section
            title={t('mobile.webpages.public.section', 'On the open internet')}
            subtitle={t('mobile.webpages.public.section_hint', 'The page’s own address, for people outside Bee Flow')}
        >
            {body}
        </Section>
    );
}

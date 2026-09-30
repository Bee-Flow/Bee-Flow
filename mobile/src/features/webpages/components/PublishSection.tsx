/**
 * Inside your organisation: the internal publish. Colleagues open the page
 * signed in, through the app — which is not the public address or the links
 * below it, and the card says so, because merging the audiences is how a
 * page meant for five colleagues ends up on the open internet.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Button, Card, Section, Text, useToast } from '@/shared/ui';

import { useRepublishWebpage, useSetWebpagePublished } from '../hooks/mutations';
import type { Webpage } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
        state: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        grow: { flex: 1 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });

function audience(webpage: Webpage, t: TranslateFn): string {
    if (!webpage.isPublished) return t('mobile.webpages.publish.only_you', 'Only you can see it');
    const groups = webpage.sharedGroups.length;
    if (groups === 0) return t('mobile.webpages.publish.everyone', 'Visible to everyone in your organisation');
    return t('mobile.webpages.publish.groups', 'Visible to {count} groups', { count: groups });
}

/**
 * Colleagues read the version pinned when the page was published, not the
 * live one, so an edit made since reaches them only through this.
 */
function RepublishButton({ pageId }: { pageId: string }) {
    const t = useTranslation();
    const { toast } = useToast();
    const republish = useRepublishWebpage(pageId, {
        onSuccess: () => toast(t('mobile.webpages.publish.republished', 'Republished to your organisation'), 'success'),
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    return (
        <Button
            label={t('webpages.publish.republish', 'Republish')}
            variant="primary"
            loading={republish.isPending}
            onPress={() => republish.mutate()}
            accessibilityHint={t(
                'webpages.publish.republish_hint',
                'Freeze the current version for the people who can already see this page',
            )}
        />
    );
}

function PublishButton({ pageId, webpage }: { pageId: string; webpage: Webpage }) {
    const t = useTranslation();
    const { toast } = useToast();
    const publish = useSetWebpagePublished(pageId, {
        onSuccess: (isPublished) =>
            toast(
                isPublished
                    ? t('mobile.webpages.publish.done', 'Published to your organisation')
                    : t('mobile.webpages.publish.withdrawn', 'Withdrawn'),
                'success',
            ),
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    const on = webpage.isPublished;
    return (
        <Button
            label={
                on ? t('mobile.webpages.publish.withdraw', 'Withdraw') : t('webpages.publish.publish', 'Publish')
            }
            variant={on ? 'secondary' : 'primary'}
            loading={publish.isPending}
            onPress={() => publish.mutate(!on)}
            accessibilityHint={
                on
                    ? t('mobile.webpages.publish.withdraw_hint', 'Stops colleagues seeing this page')
                    : t('mobile.webpages.publish.publish_hint', 'Lets colleagues in your organisation open this page')
            }
        />
    );
}

export function PublishSection({ pageId, webpage, owned }: { pageId: string; webpage: Webpage; owned: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);

    return (
        <Section title={t('mobile.webpages.publish.title', 'Inside your organisation')}>
            <Card>
                <View style={styles.body}>
                    <View style={styles.state}>
                        <Badge
                            label={
                                webpage.isPublished
                                    ? t('studio.status.published', 'Published')
                                    : t('studio.status.draft', 'Draft')
                            }
                            tone={webpage.isPublished ? 'success' : 'neutral'}
                        />
                        <Text variant="caption" tone="tertiary" style={styles.grow}>
                            {audience(webpage, t)}
                        </Text>
                    </View>
                    <Text variant="caption" tone="tertiary">
                        {t(
                            'mobile.webpages.publish.body',
                            'Colleagues open it signed in, through the app. This is not the public address or the links below.',
                        )}
                    </Text>
                    {owned ? (
                        <View style={styles.actions}>
                            {webpage.isPublished ? <RepublishButton pageId={pageId} /> : null}
                            <PublishButton pageId={pageId} webpage={webpage} />
                        </View>
                    ) : (
                        <Text variant="caption" tone="tertiary">
                            {t(
                                'mobile.webpages.publish.not_owner',
                                'Someone else owns this page, so publishing is theirs to change.',
                            )}
                        </Text>
                    )}
                </View>
            </Card>
        </Section>
    );
}

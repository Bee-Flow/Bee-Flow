/**
 * Where a framework's dates come from and when they were last checked (web
 * TimelineTab.jsx SourcesBlock): one row per https source, opened in the
 * in-app browser, then "Checked against these sources on {date}. Not legal
 * advice." or, when the review is stale, the due-for-review warning.
 * Nothing renders without sources (an older server).
 */

import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useLocale, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Group, Icon, ListRow, Text } from '@/shared/ui';

import type { Framework } from '../api/hubReaders';
import { formatCalDate } from '../model/calendarMath';

export interface SourcesGroupProps {
    sources: Framework['sources'];
    review: Framework['legal_review'];
}

const hostOf = (url: string) => url.replace(/^https:\/\//, '').split('/')[0] ?? url;

export function SourcesGroup({ sources, review }: SourcesGroupProps) {
    const t = useTranslation();
    const { locale } = useLocale();
    const styles = useThemedStyles(makeStyles);
    const safe = sources.filter((s) => s.url.startsWith('https://'));
    if (!safe.length) return null;
    const date = review?.verified_on ? formatCalDate(review.verified_on, { locale }) || review.verified_on : null;
    return (
        <Group title={t('compliance.tbl_timeline_sources', 'Sources')}>
            {safe.map((s) => (
                <ListRow
                    key={s.url}
                    title={s.label || hostOf(s.url)}
                    subtitle={hostOf(s.url)}
                    trailing={<Icon name="ExternalLink" size={14} />}
                    onPress={() => void WebBrowser.openBrowserAsync(s.url, { createTask: false })}
                    testID={`source-${s.url}`}
                />
            ))}
            {date ? (
                <View style={styles.review}>
                    <Text variant="label" tone={review?.stale ? 'warning' : 'tertiary'} testID={review?.stale ? 'sources-review-due' : 'sources-checked'}>
                        {review?.stale
                            ? t('compliance.tbl_timeline_review_due', 'Checked {date}. Due for review: more than {days} days ago, so treat these dates as unconfirmed until Bee Flow is updated.', {
                                  date,
                                  days: review.stale_after_days ?? '',
                              })
                            : t('compliance.tbl_timeline_checked', 'Checked against these sources on {date}. Not legal advice.', { date })}
                    </Text>
                </View>
            ) : null}
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        review: { paddingHorizontal: theme.spacing[3.5], paddingVertical: theme.spacing[2.5] },
    });

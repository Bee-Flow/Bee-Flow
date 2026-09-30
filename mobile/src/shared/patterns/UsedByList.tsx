/**
 * "Used by" — the tab every Studio object ends with, and the list the delete
 * decision is made from.
 *
 * Virtualised: a knowledge base behind a busy org's agents can be used by
 * hundreds of things. The header is the tab's own node; the footer is the
 * delete, when the viewer may delete.
 *
 * Three answers are kept apart, the way the web's UsedByTab keeps them:
 *   - still asking: a spinner, never "nothing";
 *   - the read failed: that sentence and a retry — not an empty list;
 *   - the read answered but could not check some kinds: the rows it has,
 *     plus a line naming the kinds nobody looked at.
 */

import { useRouter } from 'expo-router';
import React, { type ReactElement } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import type { DeleteGuardRow } from '@/core/api/deleteGuard';
import type { UsageAnswer } from '@/core/api/usage';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { Button, InsetDivider, kindLabel, ListRow, LoadingState, Text } from '@/shared/ui';

import { usageHref, usageSubtitle, usageTitle } from './usedBy';

export interface UsedByListProps {
    answer: UsageAnswer | undefined;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    /** What an empty, fully checked answer says. */
    emptyText: string;
    header?: ReactElement | null;
    /**
     * The delete, under the list it would break (the web's DangerZone sits at
     * the bottom of the Used-by tab). Absent when this viewer may not delete.
     */
    danger?: { notice: string; label: string; onPress: () => void } | null;
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingBottom: theme.spacing.xxxl },
        block: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, gap: theme.spacing.sm },
    });

const keyOf = (row: DeleteGuardRow, index: number) => `${row.kind ?? ''}:${row.id ?? index}`;

function UsageRow({ row }: { row: DeleteGuardRow }) {
    const t = useTranslation();
    const router = useRouter();
    const href = usageHref(row);
    return (
        <ListRow
            title={usageTitle(t, row)}
            subtitle={usageSubtitle(t, row)}
            chevron={Boolean(href)}
            onPress={href ? () => openRoute(router, href) : undefined}
        />
    );
}

const renderItem: ListRenderItem<DeleteGuardRow> = ({ item }) => <UsageRow row={item} />;

function Notice({ answer, isLoading, error, onRetry, emptyText, t }: UsedByListProps & { t: TranslateFn }) {
    if (isLoading && !answer) return <LoadingState label={t('usage.loading', 'Loading who uses this…')} />;
    if (error && !answer) {
        return (
            <>
                <Text variant="caption" tone="warning">
                    {t('usage.error', 'Could not load who uses this — the list may be incomplete.')}
                </Text>
                <Button label={t('visibility.groups_retry', 'Try again')} variant="secondary" size="sm" onPress={onRetry} />
            </>
        );
    }
    if (!answer) return null;
    if (answer.unchecked.length > 0) {
        const kinds = answer.unchecked.map((k) => kindLabel(t, k, 2)).join(', ');
        return (
            <Text variant="caption" tone="warning">
                {t('usage.unchecked_kinds', 'Could not be checked: {kinds}. This list is incomplete.', { kinds })}
            </Text>
        );
    }
    if (answer.usage.length === 0) {
        return (
            <Text variant="caption" tone="tertiary">
                {emptyText}
            </Text>
        );
    }
    return null;
}

export function UsedByList(props: UsedByListProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <FlatList
            data={props.answer?.usage ?? []}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ItemSeparatorComponent={InsetDivider}
            ListHeaderComponent={
                <>
                    {props.header}
                    <View style={styles.block}>
                        <Notice {...props} t={t} />
                    </View>
                </>
            }
            ListFooterComponent={
                props.danger ? (
                    <View style={styles.block}>
                        <Text variant="caption" tone="secondary">
                            {props.danger.notice}
                        </Text>
                        <Button variant="danger" label={props.danger.label} onPress={props.danger.onPress} testID="used-by-delete" />
                    </View>
                ) : null
            }
            contentContainerStyle={styles.content}
        />
    );
}

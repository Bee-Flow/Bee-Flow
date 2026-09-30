/**
 * Every finding, errors first — the pill's expanded list. A finding about a
 * step names the step and opens it at the section that fixes it; one about
 * the routine as a whole just says so.
 */

import React, { createContext, useContext } from 'react';
import { FlatList, Pressable, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Sheet, Text } from '@/shared/ui';

import type { IssueRow } from './issuesModel';

const makeStyles = (theme: Theme) => ({
    list: { paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[3], paddingBottom: theme.spacing[6], gap: theme.spacing[2] } satisfies ViewStyle,
    row: {
        flexDirection: 'row', gap: theme.spacing[2.5], padding: theme.spacing[3], borderRadius: theme.radii.md,
        borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    body: { flex: 1, minWidth: 0, gap: 2 } satisfies ViewStyle,
    error: { color: theme.colors.errorInk },
    warning: { color: theme.colors.warningInk },
    chevron: { color: theme.colors.textTertiary },
});

const OpenContext = createContext<(row: IssueRow) => void>(() => undefined);

function FindingRow({ row }: { row: IssueRow }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const onOpen = useContext(OpenContext);
    const error = row.severity === 'error';
    const opens = !!row.stepId;
    return (
        <Pressable
            onPress={() => onOpen(row)}
            disabled={!opens}
            accessibilityRole={opens ? 'button' : 'text'}
            accessibilityHint={opens ? t('mobile.flow.issues.row_hint', 'Opens the step where this is fixed') : undefined}
            style={({ pressed }) => [styles.row, pressed && opens ? styles.pressed : null]}
            testID={`issue-${row.key}`}
        >
            <Icon name={error ? 'CircleAlert' : 'TriangleAlert'} size={16} color={(error ? styles.error : styles.warning).color} />
            <View style={styles.body}>
                <Text variant="caption" weight="semibold" tone="secondary" numberOfLines={1}>
                    {row.stepLabel ?? t('mobile.flow.issues.routine', 'This routine')}
                </Text>
                <Text variant="body">{row.message}</Text>
                {row.hint ? (
                    <Text variant="caption" tone="tertiary">
                        {row.hint}
                    </Text>
                ) : null}
            </View>
            {opens ? <Icon name="ChevronRight" size={16} color={styles.chevron.color} /> : null}
        </Pressable>
    );
}

const renderRow: ListRenderItem<IssueRow> = ({ item }) => <FindingRow row={item} />;
const keyOf = (row: IssueRow) => row.key;

export function IssuesSheet({
    visible,
    rows,
    onClose,
    onOpen,
}: {
    visible: boolean;
    rows: readonly IssueRow[];
    onClose: () => void;
    onOpen: (row: IssueRow) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const errors = rows.filter((r) => r.severity === 'error').length;
    const subtitle = errors
        ? t('mobile.flow.issues.subtitle_errors', 'Fix the problems before the routine can go live')
        : t('mobile.flow.issues.subtitle_warnings', 'Nothing blocks going live; worth a look');
    return (
        <Sheet visible={visible} onClose={onClose} title={t('mobile.flow.issues.title', 'Findings')} subtitle={subtitle} scroll={false} tall>
            <OpenContext.Provider value={onOpen}>
                <FlatList data={rows as IssueRow[]} renderItem={renderRow} keyExtractor={keyOf} contentContainerStyle={styles.list} testID="issues-list" />
            </OpenContext.Provider>
        </Sheet>
    );
}

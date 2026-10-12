/**
 * The upstream data as a list: a header per step, its fields under it, each
 * with its sample value — shared by the picker sheet and the node editor's
 * Input tab, so the two read the same. Rows come from pickerModel.ts.
 *
 * Tapping a field picks it; the chevron beside a nested one opens it. The
 * list is virtualised, so its row renderer lives at module scope and reaches
 * the handlers through a context.
 */

import React, { createContext, useContext } from 'react';
import { FlatList, Pressable, View, type ListRenderItem, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { fieldLabelText } from '@/features/flow-editor/bindings';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { EmptyState, Icon, Text } from '@/shared/ui';

import { fieldName, type FieldRow, type GroupRow, type PickerRow } from './pickerModel';

interface RowActions {
    onPick: (path: string) => void;
    onToggle: (path: string) => void;
    /** Offer "use the whole group" on each header (not in a list-only picker). */
    wholeGroup: boolean;
}

const Actions = createContext<RowActions>({ onPick: () => undefined, onToggle: () => undefined, wholeGroup: false });

type Styles = ReturnType<typeof makeStyles>;

function GroupHeader({ row, styles }: { row: GroupRow; styles: Styles }) {
    const t = useTranslation();
    const { onPick, wholeGroup } = useContext(Actions);
    return (
        <View style={styles.group}>
            <Text variant="label" weight="semibold" tone="secondary" style={styles.groupLabel} numberOfLines={1}>
                {row.group.label}
            </Text>
            {wholeGroup && row.group.basePath ? (
                <Pressable
                    onPress={() => onPick(row.group.basePath)}
                    accessibilityRole="button"
                    accessibilityLabel={t('automations.mapping.use_whole_group', 'use the whole group')}
                    hitSlop={8}
                >
                    <Text variant="label" tone="accent">
                        {t('automations.mapping.use_whole_group', 'use the whole group')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

function FieldLine({ row, styles }: { row: FieldRow; styles: Styles }) {
    const t = useTranslation();
    const { onPick, onToggle } = useContext(Actions);
    const indent = styles.indent[Math.min(row.depth, 3) as 0 | 1 | 2 | 3];
    return (
        <View style={[styles.field, indent]}>
            <Pressable
                style={styles.fieldBody}
                onPress={() => onPick(row.field.path)}
                accessibilityRole="button"
                accessibilityLabel={`${fieldLabelText(row.field, t) || humanizeFieldKey(row.field.key) || row.field.key}, ${row.preview}`}
                accessibilityHint={t('automations.builder.insert_from_step', 'Insert data from a previous step')}
            >
                <Text variant="caption" weight="medium" numberOfLines={1}>
                    {fieldName(row.field, t)}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.preview}>
                    {row.preview}
                </Text>
            </Pressable>
            {row.hasChildren ? (
                <Pressable
                    onPress={() => onToggle(row.field.path)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: row.expanded }}
                    accessibilityLabel={t('automations.mapping.view_group', 'Group fields')}
                    style={styles.chevron}
                >
                    <Icon name={row.expanded ? 'ChevronDown' : 'ChevronRight'} size={16} color={styles.glyph.color} />
                </Pressable>
            ) : null}
        </View>
    );
}

function Row({ row }: { row: PickerRow }) {
    const styles = useThemedStyles(makeStyles);
    return row.kind === 'group' ? <GroupHeader row={row} styles={styles} /> : <FieldLine row={row} styles={styles} />;
}

const renderRow: ListRenderItem<PickerRow> = ({ item }) => <Row row={item} />;
const keyOf = (row: PickerRow) => row.id;

export interface VariableListProps {
    rows: PickerRow[];
    onPick: (path: string) => void;
    onToggle?: (path: string) => void;
    wholeGroup?: boolean;
    /** Shown when there is nothing upstream at all (not when a search found nothing). */
    emptyText: string;
    testID?: string;
}

export function VariableList({ rows, onPick, onToggle = () => undefined, wholeGroup = true, emptyText, testID }: VariableListProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Actions.Provider value={{ onPick, onToggle, wholeGroup }}>
            <FlatList
                testID={testID}
                data={rows}
                keyExtractor={keyOf}
                renderItem={renderRow}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.content}
                ListEmptyComponent={<EmptyState icon="Inbox" title={emptyText} />}
            />
        </Actions.Provider>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { paddingBottom: theme.spacing.xl } satisfies ViewStyle,
    group: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingTop: theme.spacing.lg,
        paddingBottom: theme.spacing.xs,
    } satisfies ViewStyle,
    groupLabel: { flex: 1, textTransform: 'uppercase', letterSpacing: 0.6 } satisfies TextStyle,
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: theme.minTouch,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    fieldBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.sm } satisfies ViewStyle,
    preview: { flex: 1, textAlign: 'right' } satisfies TextStyle,
    chevron: { paddingLeft: theme.spacing.sm } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    indent: {
        0: {} satisfies ViewStyle,
        1: { paddingLeft: theme.spacing.lg } satisfies ViewStyle,
        2: { paddingLeft: theme.spacing.xl } satisfies ViewStyle,
        3: { paddingLeft: theme.spacing.xxl } satisfies ViewStyle,
    },
});

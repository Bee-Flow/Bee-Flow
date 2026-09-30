/**
 * The step picker: a tall sheet with a search field over the palette's groups
 * — the phone's AddStepMenu / AddStepRibbon. What it lists, and what is
 * disabled and why, is pickerModel.ts; this draws it and hands back the pick.
 * A disabled row stays visible with its reason (BFSF-348: a capability and
 * the rule behind it stay discoverable).
 */

import React, { createContext, useContext, useState } from 'react';
import { Pressable, SectionList, View, type SectionListRenderItem, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowDefinition, PaletteCatalog, StepPayload } from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';
import { EmptyState, Icon, SearchField, Sheet, Text } from '@/shared/ui';

import { pickerScope, pickerSections, takesTriggers, type PickerRow, type PickerSection } from './pickerModel';

const makeStyles = (theme: Theme) => ({
    search: { paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[3], paddingBottom: theme.spacing[2] } satisfies ViewStyle,
    list: { paddingBottom: theme.spacing[6] } satisfies ViewStyle,
    header: { paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[4], paddingBottom: theme.spacing[1], backgroundColor: theme.colors.bgSecondary } satisfies ViewStyle,
    headerText: { letterSpacing: 0.55, textTransform: 'uppercase' } satisfies TextStyle,
    app: { paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] } satisfies ViewStyle,
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3], minHeight: 56, paddingHorizontal: theme.spacing[5], paddingVertical: theme.spacing[2] } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    disabled: { opacity: 0.55 } satisfies ViewStyle,
    tile: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
    body: { flex: 1, minWidth: 0, gap: 1 } satisfies ViewStyle,
});

type Styles = ReturnType<typeof makeStyles>;

/** The pick handler, for the module-level renderItem. */
const PickContext = createContext<(payload: StepPayload) => void>(() => undefined);

function ItemRow({ row }: { row: Extract<PickerRow, { kind: 'item' }> }) {
    const styles = useThemedStyles(makeStyles);
    const onPick = useContext(PickContext);
    return (
        <Pressable
            onPress={() => onPick(row.payload)}
            disabled={row.disabled}
            accessibilityRole="button"
            accessibilityLabel={row.label}
            accessibilityHint={row.reason ?? (row.secondary || undefined)}
            accessibilityState={{ disabled: row.disabled }}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null, row.disabled ? styles.disabled : null]}
            testID={`picker-${row.key}`}
        >
            <View style={styles.tile}>
                <Icon name={row.icon} size={16} color={styles.glyph.color} />
            </View>
            <View style={styles.body}>
                <Text variant="body" weight="medium" numberOfLines={1}>
                    {row.label}
                </Text>
                {row.reason || row.secondary ? (
                    <Text variant="caption" tone={row.reason ? 'warning' : 'tertiary'} numberOfLines={2}>
                        {row.reason ?? row.secondary}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}

function AppRow({ label }: { label: string }) {
    const styles: Styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.app}>
            <Text variant="caption" weight="semibold" tone="secondary">
                {label}
            </Text>
        </View>
    );
}

function SectionHeader({ title }: { title: string }) {
    const styles = useThemedStyles(makeStyles);
    if (!title) return null;
    return (
        <View style={styles.header}>
            <Text variant="label" weight="semibold" tone="tertiary" style={styles.headerText}>
                {title}
            </Text>
        </View>
    );
}

const renderItem: SectionListRenderItem<PickerRow, PickerSection> = ({ item }) =>
    item.kind === 'app' ? <AppRow label={item.label} /> : <ItemRow row={item} />;
const renderSectionHeader = ({ section }: { section: PickerSection }) => <SectionHeader title={section.title} />;
const keyOf = (row: PickerRow) => row.key;

export function NodePickerSheet({
    target,
    definition,
    catalog,
    flowlet = null,
    onClose,
    onPick,
}: {
    /** Where the pick goes; the sheet is open while this is non-null. */
    target: AddTarget | null;
    definition: FlowDefinition | null;
    catalog: PaletteCatalog | null;
    /** The flowlet being edited, or null for the routine itself. */
    flowlet?: string | null;
    onClose: () => void;
    onPick: (payload: StepPayload, target: AddTarget) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [query, setQuery] = useState('');
    const close = () => {
        setQuery('');
        onClose();
    };
    const sections: PickerSection[] =
        target && definition
            ? pickerSections(pickerScope(definition, target, { catalog, t, flowlet }), query, { triggers: takesTriggers(target) })
            : [];
    const pick = (payload: StepPayload) => {
        if (!target) return;
        setQuery('');
        onPick(payload, target);
    };
    const title = target?.kind === 'root' && !definition?.trigger?.id ? t('routines.ribbon.start_with_trigger', 'Start with a trigger') : t('routines.ribbon.search_label', 'Add a step');
    return (
        <Sheet visible={target !== null} onClose={close} title={title} scroll={false} tall>
            <View style={styles.search}>
                <SearchField value={query} onChangeText={setQuery} placeholder={t('mobile.flow.picker.search', 'Search steps and apps')} />
            </View>
            <PickContext.Provider value={pick}>
            <SectionList
                sections={sections}
                keyExtractor={keyOf}
                renderItem={renderItem}
                renderSectionHeader={renderSectionHeader}
                stickySectionHeadersEnabled
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    <EmptyState icon="Search" title={t('mobile.flow.picker.none_title', 'Nothing matches')} message={t('mobile.flow.picker.none', 'Try another word, like "email" or "wait".')} />
                }
                testID="node-picker"
            />
            </PickContext.Provider>
        </Sheet>
    );
}

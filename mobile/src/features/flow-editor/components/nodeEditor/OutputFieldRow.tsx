/**
 * One field of a hand-written output — the web's OutputFieldRow and
 * OutputFieldValue (agent-hub `Builder/OutputFieldsEditor.tsx`) for a thumb:
 * the name and its kind on one line, the value under them at full width. The
 * kind is picked from a sheet in the variable tree's words (text, number,
 * yes/no); a number gets the number keyboard, a yes/no a switch. A value with
 * structure inside it (a group, a list, a file) is shown and never offered
 * for editing: flattening it into a text box would lose it on Save, so it is
 * edited as JSON.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { KIND_WORD, kindOfValue, type FieldKind } from '@/features/flow-editor/bindings';
import { OUT_FIELD_KINDS, safeJsonText, type OutputRow } from '@/features/flow-editor/formState/outputDrafts';
import { ActionMenu, Icon, IconButton, Switch, Text, TextField } from '@/shared/ui';

import { kindPatch, textPatch, yesNoPatch, type RowPatch } from './outputFields';
import { SelectTrigger } from '../fields/SelectTrigger';

export interface OutputFieldRowProps {
    row: OutputRow;
    onPatch: (patch: RowPatch) => void;
    /** Null on the single-value face: there is nothing to remove but the value. */
    onRemove: (() => void) | null;
    testID?: string;
}

const kindWord = (t: TranslateFn, kind: FieldKind) => t(KIND_WORD[kind].key, KIND_WORD[kind].en);

/** The kind of a row, from a sheet; a nested value says what it is instead. */
function KindPicker({ row, onPatch, testID }: Omit<OutputFieldRowProps, 'onRemove'>) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    if (row.kind === 'nested') {
        return (
            <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.nestedKind} testID={testID}>
                {kindWord(t, kindOfValue(row.value))}
            </Text>
        );
    }
    const type = t('common.type', 'Type');
    return (
        <View style={styles.kind}>
            <SelectTrigger shown={kindWord(t, row.kind)} chosen onPress={() => setOpen(true)} label={type} open={open} testID={testID} />
            <ActionMenu
                visible={open}
                onClose={() => setOpen(false)}
                title={type}
                items={OUT_FIELD_KINDS.map((kind) => ({
                    id: kind,
                    label: kindWord(t, kind),
                    selected: kind === row.kind,
                    onPress: () => {
                        if (kind !== row.kind) onPatch(kindPatch(row, kind));
                    },
                }))}
            />
        </View>
    );
}

/** The value control, one per kind. Named after the field, so a screen reader says "subject value". */
function FieldValue({ row, onPatch, testID }: Omit<OutputFieldRowProps, 'onRemove'>) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const label = row.key ? t('automations.builder.value_of', '{field} value', { field: row.key }) : t('automations.builder.value_word', 'Value');
    if (row.kind === 'nested') {
        return (
            <Text variant="code" tone="tertiary" numberOfLines={3} accessibilityLabel={label} testID={testID}>
                {safeJsonText(row.value).replace(/\s+/g, ' ')}
            </Text>
        );
    }
    if (row.kind === 'yesno') {
        const on = row.value === true;
        return (
            <View style={styles.yesno}>
                <Switch value={on} onValueChange={(next) => onPatch(yesNoPatch(next))} accessibilityLabel={label} testID={testID} />
                <Text variant="body" tone="secondary">
                    {on ? t('common.yes', 'Yes') : t('common.no', 'No')}
                </Text>
            </View>
        );
    }
    // Multi-line once a line break is in it (sticky, as on the web) — and
    // always for the one nameless value, which is most often an AI step's
    // answer: a paragraph needs the Enter key.
    const multiline = row.kind === 'text' && (!!row.multiline || row.key === null);
    return (
        <TextField
            value={row.text}
            onChangeText={(text) => onPatch(textPatch(row, text))}
            placeholder={t('automations.builder.type_a_value', 'Type a value…')}
            accessibilityLabel={label}
            keyboardType={row.kind === 'number' ? 'numeric' : 'default'}
            multiline={multiline}
            maxLines={8}
            autoCapitalize="none"
            autoCorrect={false}
            testID={testID}
        />
    );
}

export function OutputFieldRow({ row, onPatch, onRemove, testID }: OutputFieldRowProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const id = (suffix: string) => (testID ? `${testID}-${suffix}` : undefined);
    return (
        <View style={styles.row} testID={testID}>
            <View style={styles.head}>
                {/* The single value has no name to type; an empty name box
                    beside it would read as a field somebody forgot. */}
                {row.key !== null ? (
                    <TextField
                        value={row.key}
                        onChangeText={(key) => onPatch({ key })}
                        placeholder={t('common.name', 'Name')}
                        accessibilityLabel={t('common.name', 'Name')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        containerStyle={styles.name}
                        testID={id('name')}
                    />
                ) : (
                    <View style={styles.name} />
                )}
                <KindPicker row={row} onPatch={onPatch} testID={id('kind')} />
                {onRemove ? (
                    <IconButton
                        tone="danger"
                        icon={<Icon name="X" size={16} color={styles.glyph.color} />}
                        onPress={onRemove}
                        accessibilityLabel={t('common.remove', 'Remove')}
                        testID={id('remove')}
                    />
                ) : null}
            </View>
            <FieldValue row={row} onPatch={onPatch} testID={id('value')} />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { gap: theme.spacing.xs } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    name: { flex: 1 } satisfies ViewStyle,
    kind: { width: 128 } satisfies ViewStyle,
    nestedKind: { width: 128, paddingHorizontal: theme.spacing.md },
    yesno: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, minHeight: theme.minTouch } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
});

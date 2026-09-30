/**
 * The Input tab — the web's Incoming column (InputDataPanel): the data the
 * steps before this one hand it, each field with its sample (real, once a
 * test or a pin has produced some). Tapping a field puts it where the author
 * was last typing in Settings, as clicking it on the web does. With no field
 * picked yet it is copied instead — as a reference (`{{path}}`), which a text
 * field pasted into shows as a pill and saves as data; the bare path would be
 * saved as the words themselves — and the toast says how to insert directly.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatPathForInsert, type VariableGroup } from '@/features/flow-editor/bindings';
import { Text, useToast } from '@/shared/ui';

import { pickerRows, toggleExpanded, useVariablePicker, VariableList } from '../variables';

function heading(t: ReturnType<typeof useTranslation>, groups: readonly VariableGroup[]): string {
    const base = t('routines.ndv.incoming', 'Incoming');
    if (groups.length === 1) return `${base} · ${t('routines.ndv.from_step', 'from {step}', { step: groups[0]?.label ?? '' })}`;
    if (groups.length > 1) return `${base} · ${t('routines.ndv.from_steps', 'from {n} earlier steps', { n: groups.length })}`;
    return base;
}

export function InputPane({ onInserted }: { onInserted: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const picker = useVariablePicker();
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const pick = (path: string) => {
        const field = picker.activeField();
        if (field) {
            field.insert(path);
            toast(t('mobile.flow.ndv.inserted', 'Added to {field}', { field: field.label }), 'success');
            onInserted();
            return;
        }
        void Clipboard.setStringAsync(formatPathForInsert(path, 'fixed'));
        toast(t('mobile.flow.ndv.copied_ref', 'Copied. Paste it into a field in Settings — or tap a field there first, and a tap here puts it straight in.'), 'success');
    };
    return (
        <View style={styles.pane} testID="input-pane">
            <View style={styles.head}>
                <Text variant="caption" weight="semibold">
                    {heading(t, picker.groups)}
                </Text>
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.ndv.input_hint', 'Tap a field to put it where you were typing in Settings. Sample values come from the last run.')}
                </Text>
            </View>
            <View style={styles.list}>
                <VariableList
                    rows={pickerRows(picker.groups, { expanded, sampleRoot: picker.sampleRoot })}
                    onPick={pick}
                    onToggle={(path) => setExpanded((prev) => toggleExpanded(prev, path))}
                    emptyText={t('routines.mapping.no_upstream', 'No upstream data yet. Connect this step to a previous one to see its output here.')}
                />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    pane: { flex: 1 } satisfies ViewStyle,
    head: { gap: theme.spacing.xs, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md } satisfies ViewStyle,
    list: { flex: 1, paddingHorizontal: theme.spacing.lg } satisfies ViewStyle,
});

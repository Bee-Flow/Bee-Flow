/**
 * Pick a data field by its NAME — the web's FieldPicker (Builder/mapping): the
 * fields that exist in the sample data ("Subject", "From", "Date"), each with
 * an example value, grouped by where they come from; the path is stored
 * without being shown. Before the first test run there is no sample, so a
 * typed name is offered too (resolved against `fallbackBase`: "subject" →
 * `item.subject`), and "Use an expression instead" is the way out for an
 * author who wants to write one.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { previewValue } from '@/features/flow-editor/bindings';
import { FieldRow, SelectTrigger } from '@/features/flow-editor/components/fields';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { OptionRow, SearchField, Sheet, Text } from '@/shared/ui';

export interface PickOption {
    path: string;
    label: string;
    sample?: unknown;
    group?: string;
}

export interface FieldPickerProps {
    /** The chosen path ('' = none). */
    path: string;
    onPick: (path: string) => void;
    options: readonly PickOption[];
    fallbackBase?: string;
    onUseExpression?: (() => void) | null;
    label?: string;
    prompt?: string;
    disabled?: boolean;
    testID?: string;
}

const lastSegment = (path: string) => path.split(/[.[\]]/).filter(Boolean).pop() ?? path;

function matches(o: PickOption, q: string): boolean {
    return !q || o.label.toLowerCase().includes(q) || o.path.toLowerCase().includes(q);
}

interface PickSheetProps {
    open: boolean;
    onClose: () => void;
    title: string;
    path: string;
    options: readonly PickOption[];
    fallbackBase: string;
    onPick: (path: string) => void;
    onUseExpression: (() => void) | null;
}

function PickSheet({ open, onClose, title, path, options, fallbackBase, onPick, onUseExpression }: PickSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const typed = query.trim().replace(/^\.+/, '');
    const pick = (next: string) => {
        setQuery('');
        onPick(next);
    };
    const typedPath = `${fallbackBase}.${typed}`;
    return (
        <Sheet visible={open} onClose={onClose} title={title} tall>
            <SearchField value={query} onChangeText={setQuery} placeholder={t('automations.mapping.search_open', 'Search fields')} />
            <View style={styles.list}>
                {options.length === 0 ? (
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.flow.picker.no_sample', 'No sample data yet — type a field name.')}
                    </Text>
                ) : null}
                {options
                    .filter((o) => matches(o, q))
                    .map((o) => (
                        <OptionRow
                            key={o.path}
                            label={o.label}
                            description={[o.group, o.sample !== undefined ? previewValue(o.sample, 32) : ''].filter(Boolean).join(' · ') || undefined}
                            selected={o.path === path}
                            onPress={() => pick(o.path)}
                        />
                    ))}
                {typed && !options.some((o) => o.path === typedPath) ? (
                    <OptionRow label={t('mobile.flow.picker.use_typed', 'Use “{name}”', { name: typed })} description={typedPath} selected={false} onPress={() => pick(typedPath)} />
                ) : null}
                {onUseExpression ? <OptionRow label={t('automations.field_picker.use_an_expression_instead', 'Use an expression instead')} selected={false} onPress={onUseExpression} /> : null}
            </View>
        </Sheet>
    );
}

export function FieldPicker({ path, onPick, options, fallbackBase = 'item', onUseExpression = null, label, prompt, disabled = false, testID }: FieldPickerProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const current = options.find((o) => o.path === path) ?? null;
    // A File type field the menu does not list (no sample yet) is still a File type, not "Attachments)".
    const fileType = path.startsWith('fileType(') ? t('condition_node.file_type.label', 'File type') : '';
    const shown = current?.label || fileType || (path ? humanizeFieldKey(lastSegment(path)) : prompt || t('mobile.flow.picker.choose_field', 'Choose a field'));
    const pick = (next: string) => {
        setOpen(false);
        onPick(next);
    };
    return (
        <FieldRow label={label}>
            <SelectTrigger
                shown={shown}
                chosen={Boolean(path)}
                onPress={() => setOpen(true)}
                label={label}
                open={open}
                disabled={disabled}
                accessory={
                    current?.sample !== undefined ? (
                        <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.sample}>
                            {previewValue(current.sample, 24)}
                        </Text>
                    ) : null
                }
                testID={testID}
            />
            <PickSheet
                open={open}
                onClose={() => setOpen(false)}
                title={label ?? t('mobile.flow.picker.choose_field', 'Choose a field')}
                path={path}
                options={options}
                fallbackBase={fallbackBase}
                onPick={pick}
                onUseExpression={
                    onUseExpression
                        ? () => {
                              setOpen(false);
                              onUseExpression();
                          }
                        : null
                }
            />
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    sample: { maxWidth: 120 },
    list: { marginHorizontal: -theme.spacing[5], marginTop: theme.spacing.sm } satisfies ViewStyle,
});

/**
 * "Working through ‹gmail search› · Results — 10 items", with a Change that
 * reveals the list path and the input cap — the web's SourceSummaryRow
 * (collectionEditors.jsx), shared by the Condition node and Edit data so the
 * two list-mode steps read the same. A list the summary cannot describe is
 * shown as its raw path, in the warning tone.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { collectArrayPaths, walkPath, type VariableGroup } from '@/features/flow-editor/bindings';
import { BindingInput, FieldRow, NumberField } from '@/features/flow-editor/components/fields';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { Button, Text } from '@/shared/ui';

export interface SourceDescription {
    stepLabel: string | null;
    fieldLabel: string;
    count: number | null;
}

/** The one-line description of a source list, or null when it resolves to nothing describable. */
export function describeSourceList(source: unknown, groups: readonly VariableGroup[], sampleRoot: unknown): SourceDescription | null {
    const path = String(source || '').trim();
    if (!path) return null;
    const match = collectArrayPaths([...groups], sampleRoot).find((a) => a.path === path);
    if (!match) return null;
    const owner = groups.find((g) => g.basePath && path.startsWith(g.basePath));
    const resolved = sampleRoot ? walkPath(path, sampleRoot) : undefined;
    const list = Array.isArray(resolved) ? resolved : Array.isArray(match.sample) ? match.sample : null;
    return { stepLabel: owner?.label ?? null, fieldLabel: humanizeFieldKey(match.key), count: list ? list.length : null };
}

export interface SourceSummaryProps {
    hint: string;
    source: string;
    maxItems: unknown;
    onSource: (source: string) => void;
    onMaxItems: (maxItems: number | '') => void;
    groups: readonly VariableGroup[];
    sampleRoot: unknown;
    disabled?: boolean;
}

export function SourceSummary({ hint, source, maxItems, onSource, onMaxItems, groups, sampleRoot, disabled = false }: SourceSummaryProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const summary = describeSourceList(source, groups, sampleRoot);
    const line = summary
        ? [
              `${summary.stepLabel ?? t('automations.ndv.prev_step', 'Previous step')} · ${summary.fieldLabel}`,
              summary.count != null ? t('automations.canvas.result.items', '{n} items', { n: summary.count }) : '',
          ]
              .filter(Boolean)
              .join(' — ')
        : source || t('mobile.flow.list.none_yet', 'No list picked yet');
    return (
        <FieldRow label={t('mobile.flow.list.working_through', 'Working through')} hint={hint}>
            <View style={styles.row}>
                <Text variant="body" tone={summary ? 'primary' : 'warning'} numberOfLines={2} style={styles.line}>
                    {line}
                </Text>
                <Button
                    size="sm"
                    variant="ghost"
                    label={open ? t('mobile.flow.list.done', 'done') : t('automations.builder.change_word', 'change')}
                    onPress={() => setOpen((v) => !v)}
                    accessibilityHint={open ? t('mobile.flow.list.done_hint', 'Done changing the source list') : t('mobile.flow.list.change_hint', 'Change the source list')}
                />
            </View>
            {open ? (
                <View style={styles.fields}>
                    <BindingInput
                        mode="path"
                        list
                        required
                        value={source}
                        onChange={(v) => onSource(String(v))}
                        label={t('mobile.flow.list.source', 'Source list')}
                        hint={t('mobile.flow.list.source_hint', 'Pick a list from a previous step — or type a path manually.')}
                        prompt={t('mobile.flow.list.none_yet', 'No list picked yet')}
                        disabled={disabled}
                    />
                    <NumberField
                        label={t('mobile.flow.list.max_items', 'Max input items')}
                        value={maxItems}
                        min={1}
                        max={10000}
                        integer
                        allowBlank
                        prompt="10000"
                        onChange={onMaxItems}
                        disabled={disabled}
                    />
                </View>
            ) : null}
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    line: { flex: 1 },
    fields: { gap: theme.spacing.md, marginTop: theme.spacing.sm } satisfies ViewStyle,
});

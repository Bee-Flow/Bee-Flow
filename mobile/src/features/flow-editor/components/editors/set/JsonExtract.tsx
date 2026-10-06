/**
 * "Some of this data is JSON text · Pick fields from it" — the web's
 * JsonExtractSection (setEditors.jsx), the Parse JSON node's successor folded
 * into Edit data. Shown only when an upstream value (in list mode, a field of
 * the current row) is text that parses to an object or a list; a tap on a key
 * adds a computed field `parseJson(<source>, "<path>")`.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { walkPath, type VariableGroup } from '@/features/flow-editor/bindings';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { readablePath } from '@/features/flow-editor/components/outline/readableText';
import { useVariablePicker } from '@/features/flow-editor/components/variables';
import { Button, Chip, Icon, Text } from '@/shared/ui';

import { flip, pickRows, type PickRow, type PickState } from './jsonPick';
import { addJsonField, jsonCandidates, parseSampleSource, type JsonCandidate } from './setModel';
import { Note } from '../shared/Note';

function Row({ row, state, setState, onPick }: { row: PickRow; state: PickState; setState: (s: PickState) => void; onPick: (path: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const indent = { paddingLeft: row.depth * 14 };
    if (row.kind === 'empty' || row.kind === 'more') {
        return (
            <Text variant="caption" tone="tertiary" style={indent}>
                {row.kind === 'empty' ? t('mobile.flow.set.empty_list', 'empty list') : t('mobile.flow.set.n_more', '… {n} more', { n: row.n })}
            </Text>
        );
    }
    if (row.kind === 'each') {
        const choose = (each: boolean) => setState({ ...state, each: each === row.each ? state.each : flip(state.each, row.arrayPath) });
        return (
            <View style={[styles.chips, indent]}>
                <Chip label={t('mobile.flow.set.first_item', 'first item')} selected={!row.each} onPress={() => choose(false)} />
                <Chip label={t('mobile.flow.set.each_item', 'each item')} selected={row.each} onPress={() => choose(true)} />
            </View>
        );
    }
    return (
        <View style={[styles.node, indent]}>
            {row.hasChildren ? (
                <Pressable onPress={() => setState({ ...state, toggled: flip(state.toggled, row.path) })} accessibilityRole="button" accessibilityLabel={t('mobile.flow.set.toggle', 'Toggle {key}', { key: row.key })} hitSlop={8}>
                    <Icon name={row.open ? 'ChevronDown' : 'ChevronRight'} size={14} color={styles.glyph.color} />
                </Pressable>
            ) : (
                <View style={styles.spacer} />
            )}
            <Pressable onPress={row.pickable ? () => onPick(row.path) : undefined} disabled={!row.pickable} accessibilityRole="button" style={[styles.pick, !row.pickable && styles.off]}>
                <Text variant="caption" weight="medium" numberOfLines={1}>
                    {row.key}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.grow}>
                    {row.preview}
                </Text>
            </Pressable>
        </View>
    );
}

interface PanelProps {
    candidates: readonly JsonCandidate[];
    customSource: string | null;
    setCustomSource: (path: string) => void;
    sampleRoot: unknown;
    onPick: (sourcePath: string, relPath: string) => void;
    onHide: () => void;
}

function JsonPanel({ candidates, customSource, setCustomSource, sampleRoot, onPick, onHide }: PanelProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const picker = useVariablePicker();
    const [changing, setChanging] = useState(false);
    const [state, setState] = useState<PickState>({ toggled: new Set(), each: new Set() });
    const sourcePath = customSource ?? candidates[0]?.path ?? '';
    // A source typed in by hand is named as its pill is, not shown as the path.
    const sourceLabel = candidates.find((c) => c.path === sourcePath)?.label || readablePath(sourcePath, picker.stepLabelById);
    const parsed = sourcePath && sampleRoot ? parseSampleSource(walkPath(sourcePath, sampleRoot)) : undefined;
    const rows = parsed !== null && typeof parsed === 'object' ? pickRows(parsed, state) : null;
    return (
        <View style={styles.panel}>
            <View style={styles.head}>
                <Text variant="caption" tone="secondary" numberOfLines={1} style={styles.grow}>
                    {t('mobile.flow.set.json_from', 'From {source}', { source: sourceLabel })}
                </Text>
                <Button size="sm" variant="ghost" label={changing ? t('mobile.flow.set.done', 'done') : t('automations.builder.change_word', 'change')} onPress={() => setChanging((c) => !c)} />
                <Button size="sm" variant="ghost" label={t('mobile.flow.set.hide', 'hide')} onPress={onHide} />
            </View>
            {changing ? <BindingInput mode="path" value={sourcePath} onChange={(v) => setCustomSource(String(v))} prompt={t('mobile.flow.set.json_source_prompt', 'Tap Insert data to pick the text that holds the JSON')} /> : null}
            {rows ? (
                <>
                    {rows.map((row, i) => (
                        <Row key={i} row={row} state={state} setState={setState} onPick={(rel) => onPick(sourcePath, rel)} />
                    ))}
                    <Note>{t('mobile.flow.set.json_pick_hint', 'Tap a value to add it as a field. Extraction is exact and free — no AI involved.')}</Note>
                </>
            ) : (
                <Note>{t('mobile.flow.set.not_json', 'This doesn’t look like JSON text — pick another source.')}</Note>
            )}
        </View>
    );
}

export function JsonExtract({
    fields,
    onFields,
    listMode,
    elementSample,
    groups,
    sampleRoot,
    disabled = false,
}: {
    fields: unknown;
    onFields: (next: Record<string, unknown>) => void;
    listMode: boolean;
    elementSample: unknown;
    groups: readonly VariableGroup[];
    sampleRoot: unknown;
    disabled?: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const [customSource, setCustomSource] = useState<string | null>(null);
    const candidates = jsonCandidates({ listMode, elementSample, groups, eachRow: t('mobile.flow.set.each_row', 'each row') });
    if (disabled || (!candidates.length && customSource == null)) return null;
    if (!open) {
        return (
            <View style={styles.closed}>
                <Note>{t('mobile.flow.set.json_text', 'Some of this data is JSON text')}</Note>
                <Button size="sm" variant="ghost" label={t('mobile.flow.set.json_pick', 'Pick fields from it')} onPress={() => setOpen(true)} />
            </View>
        );
    }
    return (
        <JsonPanel
            candidates={candidates}
            customSource={customSource}
            setCustomSource={setCustomSource}
            sampleRoot={sampleRoot}
            onPick={(source, rel) => onFields(addJsonField(fields, source, rel, sampleRoot ? walkPath(source, sampleRoot) : undefined))}
            onHide={() => setOpen(false)}
        />
    );
}

const makeStyles = (theme: Theme) => ({
    closed: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.spacing.xs } satisfies ViewStyle,
    panel: {
        gap: theme.spacing.xs,
        padding: theme.spacing.sm,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    chips: { flexDirection: 'row', gap: theme.spacing.xs } satisfies ViewStyle,
    node: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, minHeight: 32 } satisfies ViewStyle,
    pick: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm } satisfies ViewStyle,
    off: { opacity: 0.6 } satisfies ViewStyle,
    spacer: { width: 14 } satisfies ViewStyle,
    grow: { flex: 1 },
    glyph: { color: theme.colors.textTertiary },
});
